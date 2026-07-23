import type { AgentConfig } from "@/features/config/model";
import { issueNumberFromBranch } from "@/features/dispatch/identity";
import type { ChangeHost } from "@/features/landing/port";
import type { RepairDefects } from "@/features/repair/policy";
import { needsRepair, renderRepairPrompt } from "@/features/repair/policy";
import type { RepairResult } from "@/features/repair/result";
import type { AgentRuntime } from "@/shared/agent-runtime";
import type { WorkspaceDriver } from "@/shared/workspace-driver";

const SUCCESSFUL_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export interface RepairServiceOptions {
  readonly agent: AgentConfig;
  readonly verificationCommands: string;
  readonly sessionSuffix: string;
  readonly includeClean: boolean;
  readonly onlyPullRequests: ReadonlySet<string>;
  readonly noSpawn: boolean;
  /**
   * Asked once per defective PR, before any ping or spawn. Unset means always
   * act (the manual subcommand); the daemon passes its in-repair ledger here so
   * an agent already working on this PR is left alone.
   */
  shouldAct?(pullRequestNumber: number, defects: RepairDefects, headSha?: string): boolean;
}

/** One-shot port of shepherd-prs.sh. Repair never owns merge authority. */
export class RepairService {
  constructor(
    private readonly options: RepairServiceOptions,
    private readonly changes: ChangeHost,
    private readonly workspace: WorkspaceDriver,
    private readonly agents: AgentRuntime,
  ) {}

  async run(dryRun = false): Promise<readonly RepairResult[]> {
    const results: RepairResult[] = [];
    // Legacy deliberately ignores an initial fetch failure.
    await this.workspace.fetchOrigin().catch(() => undefined);

    // The shell's process-substitution quirk turns a PR-list failure into an empty scan.
    for (const change of await this.changes.observeRepairChanges().catch(() => [])) {
      if (
        this.options.onlyPullRequests.size > 0 &&
        !this.options.onlyPullRequests.has(String(change.number))
      ) {
        continue;
      }
      const issueNumber = issueNumberFromBranch(change.headRefName);
      if (issueNumber === null) continue;

      // shepherd-prs.sh treats a review-thread query failure as zero unresolved.
      const unresolvedThreads = await this.changes
        .unresolvedThreadCount(change.number)
        .catch(() => 0);
      const failingChecks = change.statusCheckRollup.filter((check) => {
        if ("status" in check) {
          const conclusion = check.conclusion ?? "";
          return check.status === "COMPLETED" && !SUCCESSFUL_CONCLUSIONS.has(conclusion);
        }
        return !["SUCCESS", "PENDING", "EXPECTED"].includes(check.state);
      }).length;
      const defects: RepairDefects = {
        conflicting: change.mergeable === "CONFLICTING",
        unresolvedThreads,
        failingChecks,
      };
      if (!this.options.includeClean && !needsRepair(defects)) {
        results.push({ pullRequestNumber: change.number, action: "NOT_NEEDED", dryRun });
        continue;
      }
      if (this.options.shouldAct?.(change.number, defects, change.headSha) === false) {
        results.push({ pullRequestNumber: change.number, action: "WORKING", dryRun });
        continue;
      }

      const suffix = this.options.sessionSuffix.replace("%N", String(issueNumber));
      let sessionPattern: RegExp | undefined;
      try {
        sessionPattern = new RegExp(`${suffix}$`);
      } catch {
        // grep -E failure was swallowed by the legacy pipeline.
      }
      const session = sessionPattern
        ? (await this.agents.listSessions()).find((name) => sessionPattern.test(name))
        : undefined;
      const worktree = (await this.workspace.observeWorktrees()).find(
        (candidate) => candidate.branch === change.headRefName,
      );
      const message = renderRepairPrompt(change.number, this.options.verificationCommands);

      if (session) {
        if (!dryRun) await this.agents.ping(session, message);
        results.push({
          pullRequestNumber: change.number,
          action: "PINGED",
          dryRun,
          target: session,
        });
      } else if (worktree && !this.options.noSpawn) {
        if (!dryRun) {
          await this.agents.startRepair(change.number, worktree.path, message, this.options.agent);
        }
        results.push({
          pullRequestNumber: change.number,
          action: "SPAWNED",
          dryRun,
          target: worktree.path,
        });
      } else {
        results.push({ pullRequestNumber: change.number, action: "SKIPPED", dryRun });
      }
    }

    return results;
  }
}
