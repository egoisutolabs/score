import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import {
  createWorkIdentity,
  issueBranchPrefix,
  sessionNameForIssue,
} from "@score/core/dispatch/dispatch.identity";
import {
  hasLabel,
  type IssuePolicy,
  isOpenChildIssue,
  isOwnedIssueWorktree,
  parseDependencies,
  sortIssuesForDispatch,
  worktreeBranchIdentity,
} from "@score/core/dispatch/dispatch.policy";
import type { TaskBriefingWriter } from "@score/core/dispatch/task-briefing.interface";
import type { WorkSource } from "@score/core/dispatch/work-source.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { WorktreeProvisioner } from "@score/core/workspace-driver.interface";
import { assertKnownHarness } from "@score/shared/agent-command";
import type { AgentConfig } from "@score/shared/config/config.interface";
import type { DispatchCapacity, DispatchResult } from "./dispatch-result.interface";
import type { IssueObservation } from "./issue.interface";

export interface DispatchServiceOptions {
  readonly workspaceRoot: string;
  readonly maxParallelIssues: number;
  readonly issues: IssuePolicy;
  readonly agent: AgentConfig;
  /** Managed mode: project key namespacing every session this service creates. */
  readonly namespace?: string;
  /**
   * Harnesses the injected AgentRuntime can actually dispatch. Set by the
   * composition root that chose the runtime — core has no business knowing
   * a specific implementation's capabilities.
   */
  readonly dispatchableHarnesses: readonly AgentConfig["harness"][];
}

interface DispatchRunOptions {
  readonly dryRun?: boolean;
}

/** Exact control-flow port of legacy dispatchUnblockedIssues/startIssue. */
export class DispatchService {
  constructor(
    private readonly options: DispatchServiceOptions,
    private readonly workSource: WorkSource,
    private readonly changeHost: ChangeHost,
    private readonly workspace: WorktreeProvisioner,
    private readonly agents: AgentRuntime,
    private readonly briefings: TaskBriefingWriter,
  ) {}

  async run(options: DispatchRunOptions = {}): Promise<DispatchResult> {
    const started: number[] = [];
    const planned: number[] = [];
    const blocked: DispatchResult["blocked"][number][] = [];
    const failed: DispatchResult["failed"][number][] = [];
    // Capacity reflects the tick's entry observation — the decision it made,
    // not the post-run state. worktreeBranchIdentity keeps a detached-HEAD
    // worktree (empty branch) nameable instead of silently holding a slot (#65).
    const heldBy = (await this.#issueWorktrees()).map(worktreeBranchIdentity).sort();
    const capacity: DispatchCapacity = {
      active: heldBy.length,
      max: this.options.maxParallelIssues,
      heldBy,
      starved: false,
    };
    let slots = Math.max(0, capacity.max - capacity.active);
    if (slots === 0) {
      // Read-only: nothing can start here; this only decides whether the full
      // slots are genuinely holding up work (#65).
      const starved = await this.#hasWaitingCandidate(await this.#observeCandidates(), heldBy);
      return { started, planned, blocked, failed, capacity: { ...capacity, starved } };
    }

    const candidates = await this.#observeCandidates();

    for (const candidate of candidates) {
      if (slots === 0) break;
      if (await this.#alreadyInFlight(candidate.number)) {
        blocked.push({ issueNumber: candidate.number, reasons: ["ALREADY_IN_FLIGHT"] });
        continue;
      }
      if (!(await this.#dependenciesSatisfied(candidate))) {
        blocked.push({ issueNumber: candidate.number, reasons: ["DEPENDENCY_INCOMPLETE"] });
        continue;
      }

      // Legacy catches only startIssue failures. Observation failures above abort the tick.
      try {
        const didStart = await this.#startIssue(candidate.number, options.dryRun === true);
        if (!didStart) continue;
        if (options.dryRun) planned.push(candidate.number);
        else started.push(candidate.number);
        slots -= 1;
      } catch (error) {
        failed.push({ issueNumber: candidate.number, message: errorMessage(error) });
      }
    }

    return { started, planned, blocked, failed, capacity };
  }

  async #observeCandidates(): Promise<readonly IssueObservation[]> {
    return sortIssuesForDispatch(
      (await this.workSource.observeIssues()).filter((issue) =>
        isOpenChildIssue(issue, this.options.issues),
      ),
    );
  }

  /**
   * A candidate that would start if a slot were free — the work starvation
   * means (#65). Worktrees are observed once for the whole scan (the identity
   * list capacity already computed); PR heads are fetched lazily, only once
   * the first candidate escapes the held-worktree check — an empty or
   * fully-held list must neither pay for the paginated `gh pr list` nor fail
   * the tick on its transient errors when local state already proves nothing
   * waits. Sessions stay per-candidate targeted probes — listSessions is
   * lossy here (opencode filters to the score-<ns>- prefix, tmux's list
   * swallows probe failures that sessionExists fails closed on).
   */
  async #hasWaitingCandidate(
    candidates: readonly IssueObservation[],
    heldBranches: readonly string[],
  ): Promise<boolean> {
    // A slotted run reaches assertKnownHarness inside #startIssue and fails
    // without starting work; a freed slot that can only produce dispatch
    // failures is not waiting work, so the gate stays false.
    try {
      assertKnownHarness(this.options.agent, this.options.dispatchableHarnesses);
    } catch {
      return false;
    }
    let changeHeads: Awaited<ReturnType<ChangeHost["observeOpenChangeHeads"]>> | undefined;
    const openChangeHeads = async () =>
      (changeHeads ??= await this.changeHost.observeOpenChangeHeads());
    for (const candidate of candidates) {
      const prefix = issueBranchPrefix(candidate.number);
      if (heldBranches.some((branch) => branch.startsWith(prefix))) continue;
      if ((await openChangeHeads()).some((change) => change.headRefName.startsWith(prefix))) {
        continue;
      }
      if (
        await this.agents.sessionExists(
          sessionNameForIssue(this.options.namespace, candidate.number),
        )
      ) {
        continue;
      }
      if (!(await this.#dependenciesSatisfied(candidate))) continue;
      return true;
    }
    return false;
  }

  async #startIssue(issueNumber: number, dryRun: boolean): Promise<boolean> {
    const issue = await this.workSource.observeIssue(issueNumber);
    if (issue.state !== "OPEN") return false;
    if (hasLabel(issue, this.options.issues.umbrellaLabel)) return false;
    if (hasLabel(issue, this.options.issues.holdLabel)) return false;
    if (!(await this.#dependenciesSatisfied(issue))) return false;

    const identity = createWorkIdentity(this.options.workspaceRoot, issue, this.options.namespace);
    // Pure check, run before the dry-run return too: a dry-run preview must report the same
    // deterministic failure a real pass would hit, not silently plan an undispatchable issue.
    assertKnownHarness(this.options.agent, this.options.dispatchableHarnesses);
    if (dryRun) return true;
    await this.workspace.createWorktree(identity);
    try {
      await this.briefings.write(issue, identity);
      await this.agents.startImplementation(
        identity,
        "Read TASK.md and implement it end-to-end. Open a PR with Fixes in the body. Stop after reporting the PR URL.",
        this.options.agent,
      );
    } catch (error) {
      // The worktree was created this tick (#alreadyInFlight ruled out an older
      // one), so a mid-start failure must reclaim it — otherwise the leftover
      // reads as in-flight forever and the issue is never retried (#32). The
      // branch may survive; createWorktree reuses it on the retry. Best-effort:
      // a failed rollback leaves today's stall, never a new failure mode.
      await this.workspace
        .removeWorktree({ path: identity.worktreePath, branch: identity.branch, locked: false })
        .catch(() => {});
      throw error;
    }
    return true;
  }

  async #dependenciesSatisfied(issue: IssueObservation): Promise<boolean> {
    for (const number of parseDependencies(issue.body)) {
      const dependency = await this.workSource.observeDependency(number);
      if (!(dependency.state === "CLOSED" && dependency.stateReason === "COMPLETED")) return false;
    }
    return true;
  }

  async #alreadyInFlight(issueNumber: number): Promise<boolean> {
    const prefix = issueBranchPrefix(issueNumber);
    // worktreeBranchIdentity: a detached-HEAD worktree reports an empty branch
    // yet still holds its issue's slot — the raw branch would miss the
    // holder's own issue and read it as dispatchable (#65 review).
    if (
      (await this.#issueWorktrees()).some((worktree) =>
        worktreeBranchIdentity(worktree).startsWith(prefix),
      )
    ) {
      return true;
    }
    if (await this.agents.sessionExists(sessionNameForIssue(this.options.namespace, issueNumber))) {
      return true;
    }
    return (await this.changeHost.observeOpenChangeHeads()).some((change) =>
      change.headRefName.startsWith(prefix),
    );
  }

  async #issueWorktrees() {
    return (await this.workspace.observeWorktrees()).filter((worktree) =>
      isOwnedIssueWorktree(worktree, this.options.workspaceRoot),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
