import type { AgentRuntime } from "@score/core/agent-runtime";
import { issueNumberFromBranch } from "@score/core/dispatch/identity";
import type { ChangeHost } from "@score/core/landing/port";
import type { RepairDefects } from "@score/core/repair/policy";
import { needsRepair, renderRepairPrompt } from "@score/core/repair/policy";
import type { RepairResult } from "@score/core/repair/result";
import type { WorkspaceDriver } from "@score/core/workspace-driver";
import type { AgentConfig } from "@score/shared/config/model";

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
  /**
   * Landing's build-red handoff (epic decision 11): the gate-failure tail for
   * this PR, if landing's merged-tree gate failed. Unset for the manual
   * subcommand — its scan stays GitHub-facts-only.
   */
  buildRed?(pullRequestNumber: number): string | undefined;
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
      const buildRed = this.options.buildRed?.(change.number);
      const defects: RepairDefects = {
        conflicting: change.mergeable === "CONFLICTING",
        unresolvedThreads,
        failingChecks,
        ...(buildRed !== undefined && { buildRed }),
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
      const message = renderRepairPrompt(
        change.number,
        this.options.verificationCommands,
        buildRed,
      );

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
