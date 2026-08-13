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
} from "@score/core/dispatch/dispatch.policy";
import type { TaskBriefingWriter } from "@score/core/dispatch/task-briefing.interface";
import type { WorkSource } from "@score/core/dispatch/work-source.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { WorkspaceDriver } from "@score/core/workspace-driver.interface";
import { assertKnownHarness } from "@score/shared/agent-command";
import type { AgentConfig } from "@score/shared/config/config.interface";
import type { DispatchResult } from "./dispatch-result.interface";
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
    private readonly workspace: WorkspaceDriver,
    private readonly agents: AgentRuntime,
    private readonly briefings: TaskBriefingWriter,
  ) {}

  async run(options: DispatchRunOptions = {}): Promise<DispatchResult> {
    const started: number[] = [];
    const planned: number[] = [];
    const blocked: DispatchResult["blocked"][number][] = [];
    const failed: DispatchResult["failed"][number][] = [];
    const active = (await this.#issueWorktrees()).length;
    let slots = Math.max(0, this.options.maxParallelIssues - active);
    if (slots === 0) return { started, planned, blocked, failed };

    const candidates = sortIssuesForDispatch(
      (await this.workSource.observeIssues()).filter((issue) =>
        isOpenChildIssue(issue, this.options.issues),
      ),
    );

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

    return { started, planned, blocked, failed };
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
    if ((await this.#issueWorktrees()).some((worktree) => worktree.branch.startsWith(prefix))) {
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
