import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { issueNumberFromBranch } from "@score/core/dispatch/dispatch.identity";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { ReviewThreadObservation } from "@score/core/repair/findings/finding.interface";
import type { RepairDefects, RepairExhaustion } from "@score/core/repair/repair.policy";
import {
  countChecks,
  needsRepair,
  REPAIR_EXHAUSTED_LABEL,
  REPAIR_EXHAUSTED_MARKER,
  renderExhaustionComment,
  renderRepairPrompt,
} from "@score/core/repair/repair.policy";
import type { RepairHost } from "@score/core/repair/repair-host.interface";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import type { LandingWorkspace, WorktreeProvisioner } from "@score/core/workspace-driver.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";

export interface RepairServiceOptions {
  readonly agent: AgentConfig;
  readonly sessionSuffix: string;
  readonly includeClean: boolean;
  readonly onlyPullRequests: ReadonlySet<string>;
  readonly noSpawn: boolean;
  /**
   * Asked once per defective PR, before any ping or spawn. Unset means always
   * act (the manual subcommand); the daemon passes its in-repair ledger here so
   * an agent already working on this PR is left alone.
   */
  shouldAct?(
    pullRequestNumber: number,
    defects: RepairDefects,
    headSha?: string,
    diffSize?: number,
  ): boolean;
  /**
   * Asked before shouldAct: the PR's spent round budget, or undefined while
   * rounds remain. `labeled` tells the ledger whether the PR still carries the
   * exhaustion label, so a human removing it grants a fresh budget. Unset
   * (the manual subcommand) means no budget.
   */
  exhaustion?(pullRequestNumber: number, labeled: boolean): RepairExhaustion | undefined;
  /**
   * Landing's build-red handoff (epic decision 11): the gate-failure tail for
   * this PR, if landing's merged-tree gate failed. Unset for the manual
   * subcommand — its scan stays GitHub-facts-only.
   */
  /**
   * Every review thread observed for a PR this pass, before any decision.
   * The daemon routes it to the finding ledger; unset for the manual
   * subcommand. A thread query failure skips the call rather than reporting
   * an empty thread list as fact.
   */
  onThreads?(
    pullRequestNumber: number,
    threads: readonly ReviewThreadObservation[],
  ): Promise<void> | void;
  buildRed?(pullRequestNumber: number): string | undefined;
}

/** One-shot port of shepherd-prs.sh. Repair never owns merge authority. */
export class RepairService {
  constructor(
    private readonly options: RepairServiceOptions,
    private readonly changes: ChangeHost,
    // Observation slice only: repair never owns merge authority, and the
    // compiler now enforces it (#19).
    private readonly workspace: Pick<WorktreeProvisioner, "observeWorktrees"> &
      Pick<LandingWorkspace, "fetchOrigin">,
    private readonly agents: AgentRuntime,
    private readonly host: RepairHost,
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

      // shepherd-prs.sh treats a review-thread query failure as zero unresolved;
      // the full threads replace the bare count so the finding ledger sees
      // every thread the gate counts, from one query.
      const threads = await this.host.observeReviewThreads(change.number).catch(() => undefined);
      if (threads !== undefined) await this.options.onThreads?.(change.number, threads);
      const unresolvedThreads = threads?.filter((thread) => !thread.isResolved).length ?? 0;
      const checks = countChecks(change.statusCheckRollup);
      const buildRed = this.options.buildRed?.(change.number);
      const defects: RepairDefects = {
        conflicting: change.mergeable === "CONFLICTING",
        unresolvedThreads,
        failingChecks: checks.failing,
        ...(buildRed !== undefined && { buildRed }),
      };
      if (!this.options.includeClean && !needsRepair(defects)) {
        results.push({ pullRequestNumber: change.number, action: "NOT_NEEDED", dryRun });
        continue;
      }
      // The label outlives the in-memory ledger: a labeled PR stays parked
      // across daemon restarts until a human removes the label.
      const labeled = change.labels.some((label) => label.name === REPAIR_EXHAUSTED_LABEL);
      if (labeled) {
        results.push({
          pullRequestNumber: change.number,
          action: "EXHAUSTED",
          dryRun,
          target: REPAIR_EXHAUSTED_LABEL,
        });
        continue;
      }
      // A ping while the reviewer's check is still running makes the agent
      // fix round N while round N+1 is being written (analysis §1): in PR 99
      // every fix commit landed 2–6 minutes after the previous review.
      if (checks.pending > 0) {
        results.push({ pullRequestNumber: change.number, action: "CHECKS_PENDING", dryRun });
        continue;
      }
      const exhaustion = this.options.exhaustion?.(change.number, labeled);
      if (exhaustion !== undefined) {
        if (!dryRun) await this.#markExhausted(change.number, exhaustion);
        results.push({
          pullRequestNumber: change.number,
          action: "EXHAUSTED",
          dryRun,
          target: REPAIR_EXHAUSTED_LABEL,
          parked: { rule: exhaustion.rule, detail: exhaustion.detail },
        });
        continue;
      }
      const diffSize =
        change.additions !== undefined && change.deletions !== undefined
          ? change.additions + change.deletions
          : undefined;
      if (this.options.shouldAct?.(change.number, defects, change.headSha, diffSize) === false) {
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
      const message = renderRepairPrompt(change.number, buildRed);

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

  /**
   * Comment, then label. The comment carries the history a human needs, so it
   * goes first; the marker check makes a retry after a death between the two
   * steps add the label without a second comment (INVARIANTS.md, RETRIED).
   */
  async #markExhausted(pullRequestNumber: number, exhaustion: RepairExhaustion): Promise<void> {
    if (!(await this.host.hasComment(pullRequestNumber, REPAIR_EXHAUSTED_MARKER))) {
      await this.host.comment(
        pullRequestNumber,
        renderExhaustionComment(pullRequestNumber, exhaustion),
      );
    }
    await this.host.addLabel(pullRequestNumber, REPAIR_EXHAUSTED_LABEL);
  }
}
