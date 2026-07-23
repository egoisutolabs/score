import { cleanupStatusIsSafe } from "@/features/cleanup/policy";
import type { CleanupResult } from "@/features/cleanup/result";
import { issueNumberFromBranch, sessionNameForIssue } from "@/features/dispatch/identity";
import { isOwnedIssueWorktree } from "@/features/dispatch/policy";
import type { ChangeHost } from "@/features/landing/port";
import type { AgentRuntime } from "@/shared/agent-runtime";
import type { WorkspaceDriver } from "@/shared/workspace-driver";

export interface CleanupServiceOptions {
  readonly defaultBranch: string;
  readonly workspaceRoot: string;
  readonly harnessOwnedPaths: readonly string[];
  readonly autoPullMain: boolean;
  /** Managed mode: project key; must match the namespace dispatch launched with. */
  readonly namespace?: string;
}

/** Cleanup acts only on merged PR observations and refuses unknown worktree dirt. */
export class CleanupService {
  constructor(
    private readonly options: CleanupServiceOptions,
    private readonly changes: ChangeHost,
    private readonly workspace: WorkspaceDriver,
    private readonly agents: AgentRuntime,
  ) {}

  async run(dryRun = false): Promise<readonly CleanupResult[]> {
    const results: CleanupResult[] = [];
    let cleaned = 0;
    for (const change of await this.changes.observeMergedOwnedChanges()) {
      const worktrees = (await this.workspace.observeWorktrees()).filter((worktree) =>
        isOwnedIssueWorktree(worktree, this.options.workspaceRoot),
      );
      const worktree = worktrees.find((candidate) => candidate.branch === change.headRefName);
      if (!worktree) {
        results.push({ pullRequestNumber: change.number, action: "NOT_FOUND" });
        continue;
      }

      const status = await this.workspace.status(worktree.path);
      if (!cleanupStatusIsSafe(status, this.options.harnessOwnedPaths)) {
        results.push({
          pullRequestNumber: change.number,
          action: "BLOCKED_DIRTY",
          message: "worktree contains changes outside the harness allowlist",
        });
        continue;
      }
      cleaned += 1;
      if (dryRun) {
        results.push({ pullRequestNumber: change.number, action: "PLANNED" });
        continue;
      }

      const issueNumber = issueNumberFromBranch(worktree.branch);
      if (issueNumber !== null) {
        await this.agents.stop(sessionNameForIssue(this.options.namespace, issueNumber));
      }
      await this.workspace.removeWorktree(worktree);
      // Legacy treats safe local-branch deletion failure as a warning, not failed cleanup.
      await this.workspace.deleteBranch(worktree.branch);
      results.push({ pullRequestNumber: change.number, action: "CLEANED" });
    }

    // A clean, correctly checked-out primary branch is the only path to an automatic pull.
    if (cleaned > 0 && this.options.autoPullMain) {
      await this.workspace.fastForwardDefaultBranch(this.options.defaultBranch);
    }
    return results;
  }
}
