import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import {
  autoPullRefusalReason,
  cleanupStatusIsSafe,
  decideStranded,
  type StrandedEntry,
  strandedPingMessage,
  strandedRespawnPrompt,
} from "@score/core/cleanup/cleanup.policy";
import type {
  CleanupResult,
  StrandedCleanupResult,
} from "@score/core/cleanup/cleanup-result.interface";
import { issueNumberFromBranch, sessionNameForIssue } from "@score/core/dispatch/dispatch.identity";
import { isOwnedIssueWorktree, worktreeBranchIdentity } from "@score/core/dispatch/dispatch.policy";
import type { WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { PullRequestIdentity } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { LandingWorkspace, WorktreeProvisioner } from "@score/core/workspace-driver.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";

export interface CleanupServiceOptions {
  readonly defaultBranch: string;
  readonly workspaceRoot: string;
  readonly harnessOwnedPaths: readonly string[];
  readonly autoPullMain: boolean;
  /** Harness config for the stranded ladder's respawn reconcile (#64). */
  readonly agent: AgentConfig;
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
    private readonly workspace: WorktreeProvisioner &
      Pick<LandingWorkspace, "fastForwardDefaultBranch" | "observePrimaryCheckout">,
    private readonly agents: AgentRuntime,
  ) {}

  async run(dryRun = false): Promise<readonly CleanupResult[]> {
    const results: CleanupResult[] = [];
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

    // A clean, correctly checked-out primary branch is the only path to an
    // automatic pull — attempted every pass, not only after a cleanup (#91):
    // a quiet fleet must not run stale, and a refusal must be loud, or dirt
    // in the primary silently strands every new worktree on old main.
    if (this.options.autoPullMain) {
      const pulled = await this.workspace.fastForwardDefaultBranch(this.options.defaultBranch);
      if (!pulled) {
        const primary = await this.workspace.observePrimaryCheckout();
        results.push({
          action: "AUTO_PULL_REFUSED",
          message: autoPullRefusalReason(primary, this.options.defaultBranch),
        });
      }
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
    // A branch with any PR — open (repair's domain), merged (the loop
    // above's domain), or closed (an operator's abandonment verdict) — is
    // never stranded.
    const branchesWithChanges = new Set(
      [
        ...(await this.changes.observeOpenChangeHeads()),
        ...merged,
        ...(await this.changes.observeClosedOwnedChanges()),
      ].map((change) => change.headRefName),
    );
    const seen = new Set<number>();
    const worktrees = (await this.workspace.observeWorktrees()).filter((worktree) =>
      isOwnedIssueWorktree(worktree, this.options.workspaceRoot),
    );
    for (const worktree of worktrees) {
      // Branch-or-basename, like the ownership predicate above: a
      // detached-HEAD worktree still holds a slot and must not silently
      // leave the stranded universe (or slip past the PR exclusion).
      const branch = worktreeBranchIdentity(worktree);
      if (branchesWithChanges.has(branch)) continue;
      const issueNumber = issueNumberFromBranch(branch);
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

      // Pre-check before quiescing: a worktree that already holds work must
      // never cost a still-live agent its session.
      const dirty = await this.#strandedDirt(worktree);
      if (dirty !== undefined) {
        results.push(
          await this.#preserveDirtyWorktree(
            { worktree, branch, issueNumber, sessionName, sessionAlive, dirt: dirty },
            dryRun,
            tick,
          ),
        );
        continue;
      }
      if (!dryRun) {
        // The merged loop's exact verb sequence, with its proven boundary
        // behavior: a death after stop re-enters here next tick (the missing
        // session reclaims immediately); after removeWorktree the surviving
        // branch is the same benign leftover redispatch reattaches to.
        await this.agents.stop(sessionName);
        // stop() tolerates a missing session, so its return proves nothing —
        // TmuxService swallows kill-session failures. Only an observed-absent
        // session is quiescence; a survivor could keep writing after the
        // snapshot below, so the reclaim defers loudly and the still-elapsed
        // window retries it next tick.
        if (await this.agents.sessionExists(sessionName)) {
          results.push({
            issueNumber,
            action: "STRANDED_DIRTY",
            dryRun,
            message: "agent session survived stop; leaving the worktree untouched",
          });
          continue;
        }
        // A live agent can write or commit between any check and the forced
        // removal, so only a re-observation after the session is gone counts:
        // last-second work surfaces as STRANDED_DIRTY (loud, preserved, and
        // re-judged next tick on the session-missing path) instead of being
        // erased by `worktree remove --force`.
        const fresh = (await this.workspace.observeWorktrees()).find(
          (candidate) => candidate.path === worktree.path,
        );
        const freshDirt = fresh === undefined ? undefined : await this.#strandedDirt(fresh);
        if (fresh !== undefined && freshDirt !== undefined) {
          // The stop raced a last-second write or commit; the session is
          // already gone, so this always takes the respawn arm below.
          results.push(
            await this.#preserveDirtyWorktree(
              {
                worktree: fresh,
                branch,
                issueNumber,
                sessionName,
                sessionAlive: false,
                dirt: freshDirt,
              },
              dryRun,
              tick,
            ),
          );
          continue;
        }
        if (fresh !== undefined) {
          await this.workspace.removeWorktree(fresh);
          await this.workspace.deleteBranch(branch);
        }
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

  /**
   * Dirt at the reclaim window is never destroyed. With the agent still
   * alive it stays loud and untouched — the agent may yet finish. With the
   * session gone (a crash, or our own quiesce racing a last-second write)
   * nobody would ever finish the preserved work, so the reconcile is to
   * respawn an implementation agent in the same worktree, with the ledger
   * window restarted so the revived agent gets full silence windows again.
   * Convergent across a death before the respawn: the next tick re-enters
   * this exact arm (session missing, dirt observed) and retries it.
   */
  async #preserveDirtyWorktree(
    stranded: {
      worktree: WorktreeObservation;
      branch: string;
      issueNumber: number;
      sessionName: string;
      sessionAlive: boolean;
      dirt: string;
    },
    dryRun: boolean,
    tick: number,
  ): Promise<StrandedCleanupResult> {
    const { worktree, branch, issueNumber, sessionName, sessionAlive, dirt } = stranded;
    if (sessionAlive) {
      return { issueNumber, action: "STRANDED_DIRTY", dryRun, message: dirt };
    }
    // A detached checkout cannot host a useful respawn: both runtimes just
    // launch in worktree.path, so the new agent's commits would stay
    // off-branch and its PR could never target the issue branch — each dead
    // replacement would re-enter this arm instead of converging. Leave the
    // state loud for explicit operator recovery (clean detached worktrees
    // still reclaim normally above).
    if (worktree.branch === "") {
      return {
        issueNumber,
        action: "STRANDED_DIRTY",
        dryRun,
        message: `${dirt}; worktree is detached from its branch — operator recovery required`,
      };
    }
    if (!dryRun) {
      await this.agents.startImplementation(
        { issueNumber, branch, worktreePath: worktree.path, sessionName },
        strandedRespawnPrompt(issueNumber),
        this.options.agent,
      );
      this.#stranded.set(issueNumber, { sinceTick: tick, headSha: worktree.headSha });
    }
    return { issueNumber, action: "STRANDED_RESPAWNED", dryRun, message: dirt };
  }

  /** Undefined when the worktree holds nothing of value; else the loud reason. */
  async #strandedDirt(worktree: WorktreeObservation): Promise<string | undefined> {
    const status = await this.workspace.status(worktree.path);
    if (!cleanupStatusIsSafe(status, this.options.harnessOwnedPaths)) {
      return "worktree contains changes outside the harness allowlist";
    }
    // An unknown headSha fails the ahead-of-base proof closed.
    if (
      worktree.headSha === undefined ||
      !(await this.workspace.isAncestor(worktree.headSha, this.options.defaultBranch))
    ) {
      return "branch has commits not on the base branch";
    }
    return undefined;
  }
}
