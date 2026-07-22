import { createWorkIdentity } from "@/features/dispatch/identity";
import type { IssueObservation } from "@/features/dispatch/issue";
import {
  hasLabel,
  type IssuePolicy,
  isOpenChildIssue,
  isOwnedIssueWorktree,
  parseDependencies,
  sortIssuesForDispatch,
} from "@/features/dispatch/policy";
import type { DispatchResult } from "@/features/dispatch/result";
import type { TaskBriefingWriter } from "@/features/dispatch/task-briefing-port";
import type { WorkSource } from "@/features/dispatch/work-source";
import type { ChangeHost } from "@/features/landing/port";
import type { AgentRuntime } from "@/shared/agent-runtime";
import type { WorkspaceDriver } from "@/shared/workspace-driver";

export interface DispatchServiceOptions {
  readonly workspaceRoot: string;
  readonly maxParallelIssues: number;
  readonly issues: IssuePolicy;
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

    const identity = createWorkIdentity(this.options.workspaceRoot, issue);
    if (dryRun) return true;
    await this.workspace.createWorktree(identity);
    await this.briefings.write(issue, identity);
    await this.agents.startImplementation(
      identity,
      "Read TASK.md and implement it end-to-end. Open a PR with Fixes in the body. Stop after reporting the PR URL.",
    );
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
    const prefix = `issue-${issueNumber}-`;
    if ((await this.#issueWorktrees()).some((worktree) => worktree.branch.startsWith(prefix))) {
      return true;
    }
    if (await this.agents.sessionExists(`issue-${issueNumber}`)) return true;
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
