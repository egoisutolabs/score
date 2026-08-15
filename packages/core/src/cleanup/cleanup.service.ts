import type { GitService } from "@score/core/adapters/git.service";
import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import {
  cleanupStatusIsSafe,
  decideStranded,
  type StrandedEntry,
  strandedPingMessage,
} from "@score/core/cleanup/cleanup.policy";
import type {
  CleanupResult,
  StrandedCleanupResult,
} from "@score/core/cleanup/cleanup-result.interface";
import { issueNumberFromBranch, sessionNameForIssue } from "@score/core/dispatch/dispatch.identity";
import { isOwnedIssueWorktree } from "@score/core/dispatch/dispatch.policy";
import type { PullRequestIdentity } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { LandingWorkspace, WorktreeProvisioner } from "@score/core/workspace-driver.interface";

export interface CleanupServiceOptions {
  readonly defaultBranch: string;
  readonly workspaceRoot: string;
  readonly harnessOwnedPaths: readonly string[];
  readonly autoPullMain: boolean;
  /** Managed mode: project key; must match the namespace dispatch launched with. */
  readonly namespace?: string;
  /** Ticks of silence before the stranded ladder pings, and again before it reclaims. */
  readonly staleTicks?: number;
}

/** Cleanup acts only on merged PR observations and refuses unknown worktree dirt. */
export class CleanupService {
  /**
   * Stranded-issue ledger (#64) — in-memory like RepairLedger: a restart
   * costs at most one extra full silence window, never a lost worktree.
   */
  readonly #stranded = new Map<number, StrandedEntry>();
  #tick = 0;

  constructor(
    private readonly options: CleanupServiceOptions,
    private readonly changes: ChangeHost,
    // Worktree authority plus the one landing-side verb cleanup legitimately
    // performs (autoPullMain); no merge or push method is visible here (#19).
    // isAncestor is read-only evidence for the stranded ladder: proof a
    // branch has no commits of its own before its worktree may be reclaimed.
    private readonly workspace: WorktreeProvisioner &
      Pick<LandingWorkspace, "fastForwardDefaultBranch"> &
      Pick<GitService, "isAncestor">,
    private readonly agents: AgentRuntime,
  ) {}

  async run(dryRun = false): Promise<readonly CleanupResult[]> {
    const results: CleanupResult[] = [];
    let cleaned = 0;
    const merged = await this.changes.observeMergedOwnedChanges();
    for (const change of merged) {
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

    results.push(...(await this.#reclaimStranded(merged, dryRun)));

    // A clean, correctly checked-out primary branch is the only path to an automatic pull.
    if (cleaned > 0 && this.options.autoPullMain) {
      await this.workspace.fastForwardDefaultBranch(this.options.defaultBranch);
    }
    return results;
  }

  /**
   * Stranded-issue ladder (#64): a worktree whose branch has no PR at all is
   * outside repair's universe (PRs only) and the merged loop above, so a
   * born-then-silent agent leaks its slot forever. Ping after `staleTicks`
   * of no commits, reclaim after a second silent window — immediately when
   * the session is already gone — and only a worktree holding nothing: clean
   * modulo the harness allowlist and no commits ahead of base. Anything else
   * stays loud as STRANDED_DIRTY every tick; nothing is destroyed silently.
   */
  async #reclaimStranded(
    merged: readonly PullRequestIdentity[],
    dryRun: boolean,
  ): Promise<readonly StrandedCleanupResult[]> {
    const tick = this.#tick++;
    const staleTicks = this.options.staleTicks ?? 10;
    const results: StrandedCleanupResult[] = [];
    // A branch with any PR — open (repair's domain) or merged (the loop
    // above's domain) — is never stranded.
    const branchesWithChanges = new Set(
      [...(await this.changes.observeOpenChangeHeads()), ...merged].map(
        (change) => change.headRefName,
      ),
    );
    const seen = new Set<number>();
    const worktrees = (await this.workspace.observeWorktrees()).filter((worktree) =>
      isOwnedIssueWorktree(worktree, this.options.workspaceRoot),
    );
    for (const worktree of worktrees) {
      if (branchesWithChanges.has(worktree.branch)) continue;
      const issueNumber = issueNumberFromBranch(worktree.branch);
      if (issueNumber === null) continue;
      seen.add(issueNumber);

      let entry = this.#stranded.get(issueNumber);
      // A new commit is progress: the silence window restarts from it.
      if (entry === undefined || entry.headSha !== worktree.headSha) {
        entry = { sinceTick: tick, headSha: worktree.headSha };
        this.#stranded.set(issueNumber, entry);
      }
      const sessionName = sessionNameForIssue(this.options.namespace, issueNumber);
      const sessionAlive = await this.agents.sessionExists(sessionName);
      const decision = decideStranded(entry, tick, sessionAlive, staleTicks);
      if (decision === "WAIT") continue;
      if (decision === "PING") {
        if (!dryRun) {
          await this.agents.ping(sessionName, strandedPingMessage(issueNumber));
          // A dry-run ping never reached the agent, so it must not start the
          // reclaim clock (same reasoning as RepairLedger's dry-run rule).
          this.#stranded.set(issueNumber, { ...entry, pingedAtTick: tick });
        }
        results.push({ issueNumber, action: "STRANDED_PINGED", dryRun });
        continue;
      }

      const status = await this.workspace.status(worktree.path);
      // An unknown headSha fails the ahead-of-base proof closed.
      const dirty = !cleanupStatusIsSafe(status, this.options.harnessOwnedPaths)
        ? "worktree contains changes outside the harness allowlist"
        : worktree.headSha === undefined ||
            !(await this.workspace.isAncestor(worktree.headSha, this.options.defaultBranch))
          ? "branch has commits not on the base branch"
          : undefined;
      if (dirty !== undefined) {
        results.push({ issueNumber, action: "STRANDED_DIRTY", dryRun, message: dirty });
        continue;
      }
      if (!dryRun) {
        // The merged loop's exact verb sequence, with its proven boundary
        // behavior: a death after stop re-enters here next tick (the missing
        // session reclaims immediately); after removeWorktree the surviving
        // branch is the same benign leftover redispatch reattaches to.
        await this.agents.stop(sessionName);
        await this.workspace.removeWorktree(worktree);
        await this.workspace.deleteBranch(worktree.branch);
        this.#stranded.delete(issueNumber);
      }
      results.push({ issueNumber, action: "STRANDED_RECLAIMED", dryRun });
    }
    // Forget issues that left the stranded universe (a PR appeared, or the
    // worktree is gone) so a later re-dispatch starts a fresh window.
    for (const issueNumber of this.#stranded.keys()) {
      if (!seen.has(issueNumber)) this.#stranded.delete(issueNumber);
    }
    return results;
  }
}
