import type {
  BuildGate,
  LandingResult,
  PullRequestObservation,
} from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import {
  evaluatePreconditions,
  gatesFor,
  listLandingCandidates,
  meaningfulStatusLines,
} from "@score/core/landing/landing.policy";
import type { LandingWorkspace } from "@score/core/workspace-driver.interface";
import type { CommandRunner } from "@score/shared/command-runner.interface";

export interface LandingServiceOptions {
  readonly repositoryRoot: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly dryRun: boolean;
  readonly noMerge: boolean;
  readonly maxMerges: number;
  /** Consecutive green ticks required before merging (legacy soaked on wall clock). */
  readonly soakTicks: number;
  /**
   * Wall-clock time a head must have been visible to landing before it may
   * merge, so late reviewer rounds land on the PR instead of on main. Codex
   * posts a review only when it has findings (never on a clean run), so a
   * "Codex reviewed this head" signal cannot exist for a mergeable PR and the
   * wait is a timeout alone; p95 of Codex latency in the baseline was 12 min.
   */
  readonly settleMs: number;
  readonly now?: () => number;
  readonly skipLabels: readonly string[];
  readonly onlyIssueBranches: boolean;
}

/** Full port of babysitPr/tick: local integration, merged-tree gates, soak, commit, push. */
export class LandingService {
  /**
   * Soak is keyed by (PR number, head SHA): green ticks certify one exact
   * commit, never the PR number. Legacy keyed by number alone and its header
   * still claimed "a fresh push pre-empts the merge" — that only held because
   * its CI outlasted its 90s poll interval, an environmental accident this
   * implements as policy: a new head always restarts soak from zero.
   */
  readonly #readyTicks = new Map<number, { readonly headSha: string; readonly ticks: number }>();

  /**
   * When landing first saw each PR's current head, in any state — the settle
   * clock starts at the push, not at the first green tick. In memory like
   * soak: a restart restarts the wait, which only ever delays a merge.
   */
  readonly #headSeen = new Map<number, { readonly headSha: string; readonly at: number }>();

  /**
   * D1: a committed merge whose push failed halts the remaining candidates
   * for the rest of the tick. Continuing would commit a second merge on top
   * of the unpushed first, building a local-only chain whose head fails
   * recovery's authorship proof forever (its first parent is the unpushed
   * merge, not an ancestor of origin). One stray is provably recoverable; a
   * chain is not — so landing never creates one, and the next pass's
   * reconciliation clears the single stray before any new candidate stages.
   */
  #pushFailedThisTick = false;

  constructor(
    private readonly options: LandingServiceOptions,
    private readonly changes: ChangeHost,
    private readonly workspace: LandingWorkspace,
    private readonly runner: CommandRunner,
  ) {}

  async runTick(): Promise<readonly LandingResult[]> {
    this.#pushFailedThisTick = false;
    await this.workspace.fetchOrigin();
    // Before readiness, not after: a sweep interrupted last tick left dirt
    // that readiness would refuse — the retry here is what unwedges it (#92).
    await this.workspace.sweepStageResidue();
    const canMerge = this.options.dryRun || (await this.#mainCheckoutReady());
    const changes = listLandingCandidates(await this.changes.observeOpenChanges(), this.options);
    const live = new Set(changes.map((change) => change.number));
    for (const number of this.#readyTicks.keys()) {
      if (!live.has(number)) this.#readyTicks.delete(number);
    }
    for (const number of this.#headSeen.keys()) {
      if (!live.has(number)) this.#headSeen.delete(number);
    }

    const results: LandingResult[] = [];
    let merges = 0;
    for (const change of changes) {
      // Noted before the skip below: the settle clock measures how long a head
      // has been visible to landing, and a candidate skipped for a dirty
      // checkout, a halted tick, or the merge cap was visible all the same.
      const seenAt = this.#noteHead(change);
      // Every result names the head it is about, so the daemon can tell a
      // verdict on the head the agent already replaced from one on this head.
      const head = change.headSha !== undefined ? { headSha: change.headSha } : {};
      if (
        !canMerge ||
        this.#pushFailedThisTick ||
        (!this.options.dryRun && !this.options.noMerge && merges >= this.options.maxMerges)
      ) {
        results.push({
          pullRequestNumber: change.number,
          tag: "skipped",
          note: "not processed",
          ...head,
        });
        continue;
      }

      let result: LandingResult;
      try {
        result = await this.#land(change, seenAt);
      } catch (error) {
        await this.workspace.abortMerge().catch(() => undefined);
        result = {
          pullRequestNumber: change.number,
          tag: "build-red",
          note: `unexpected: ${errorMessage(error)}`,
        };
      }
      if (!result.keepTimer) this.#readyTicks.delete(change.number);
      if (result.tag === "merged") merges += 1;
      results.push({ ...result, ...head });
    }
    return results;
  }

  async #land(change: PullRequestObservation, seenAt: number | undefined): Promise<LandingResult> {
    const gates = gatesFor(this.options.repositoryRoot);
    const gateNames = gates.map((gate) => gate.name).join("+");
    // Legacy performs cheap checks before the GraphQL review-thread query.
    let blocker = evaluatePreconditions(change, 0);
    if (blocker) return blocker;
    let unresolvedThreads: number;
    try {
      unresolvedThreads = await this.changes.unresolvedThreadCount(change.number);
    } catch (error) {
      // Deliberate departure from legacy's catch(() => 0): a failed or
      // truncated observation must never read as "no unexamined feedback".
      return {
        pullRequestNumber: change.number,
        tag: "skipped",
        note: `review-thread observation failed (${errorMessage(error)}); refusing to merge this tick`,
      };
    }
    blocker = evaluatePreconditions(change, unresolvedThreads);
    if (blocker) return blocker;

    const settleRemaining =
      seenAt === undefined ? 0 : this.options.settleMs - (this.#now() - seenAt);
    if (settleRemaining > 0) {
      return {
        pullRequestNumber: change.number,
        tag: "settling",
        note: `clean+resolved; waiting ${Math.ceil(settleRemaining / 60_000)} min more for late reviews on ${change.headSha?.slice(0, 7)}`,
        keepTimer: true,
      };
    }

    if (this.options.dryRun) {
      return {
        pullRequestNumber: change.number,
        tag: "would-merge",
        note: `clean+resolved; would soak ${this.options.soakTicks} green ticks then merge (gates: ${gateNames})`,
      };
    }

    // Stage the exact commit the preconditions above vetted — never the
    // mutable branch name, which may already point at a head whose checks and
    // review nobody examined. No observed SHA = no identity = nothing merges.
    const headSha = change.headSha;
    if (headSha === undefined) {
      return {
        pullRequestNumber: change.number,
        tag: "skipped",
        note: "observation carried no head SHA; refusing to stage unvetted code",
      };
    }

    await this.workspace.fetchOrigin();
    if (!(await this.workspace.stageMerge(headSha))) {
      await this.workspace.abortMerge().catch(() => undefined);
      return {
        pullRequestNumber: change.number,
        tag: "conflict",
        note: "git merge hit conflicts (aborted)",
      };
    }

    const gateFailure = await this.#runGates(gates);
    if (gateFailure) {
      await this.workspace.abortMerge().catch(() => undefined);
      return { pullRequestNumber: change.number, tag: "build-red", note: gateFailure };
    }

    const previous = this.#readyTicks.get(change.number);
    const greenTicks = previous?.headSha === headSha ? previous.ticks + 1 : 1;
    this.#readyTicks.set(change.number, { headSha, ticks: greenTicks });
    const remaining = this.options.soakTicks - greenTicks;
    if (remaining > 0) {
      await this.workspace.abortMerge().catch(() => undefined);
      return {
        pullRequestNumber: change.number,
        tag: "soaking",
        note: `green+resolved (${gateNames}); merging ${remaining === 1 ? "next tick" : `in ${remaining} ticks`} if still green`,
        keepTimer: true,
      };
    }

    if (this.options.noMerge) {
      await this.workspace.abortMerge().catch(() => undefined);
      return {
        pullRequestNumber: change.number,
        tag: "ready",
        note: `soak complete (${gateNames}); --no-merge, not pushed`,
        keepTimer: true,
      };
    }

    const owner = this.options.repository.split("/")[0];
    const message = `Merge pull request #${change.number} from ${owner}/${change.headRefName}\n\n${change.title}`;
    await this.workspace.commitMerge(message);
    try {
      await this.workspace.pushDefaultBranch(this.options.defaultBranch);
    } catch (error) {
      this.#pushFailedThisTick = true;
      // No keepTimer: the re-land pays a fresh soak after recovery (D1).
      return {
        pullRequestNumber: change.number,
        tag: "push-failed",
        note: `merge committed but push failed (${errorMessage(error)}); halting landing this tick — reconciliation resets and re-lands (D1)`,
      };
    }
    return {
      pullRequestNumber: change.number,
      tag: "merged",
      note: `soak complete (${gateNames})`,
    };
  }

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Records a first sighting of the PR's head; returns when it was first seen, or undefined without a head. */
  #noteHead(change: PullRequestObservation): number | undefined {
    if (change.headSha === undefined) return undefined;
    const seen = this.#headSeen.get(change.number);
    if (seen?.headSha === change.headSha) return seen.at;
    const at = this.#now();
    this.#headSeen.set(change.number, { headSha: change.headSha, at });
    return at;
  }

  async #mainCheckoutReady(): Promise<boolean> {
    const checkout = await this.workspace.observePrimaryCheckout();
    if (checkout.branch !== this.options.defaultBranch) return false;
    return meaningfulStatusLines(checkout.status).length === 0;
  }

  async #runGates(gates: readonly BuildGate[]): Promise<string | null> {
    for (const gate of gates) {
      for (const step of gate.steps) {
        let result = await this.#tryGateStep(step, gate.cwd);
        if (!result.ok && step.retry) result = await this.#tryGateStep(step, gate.cwd);
        if (!result.ok) {
          const tail = result.output.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ");
          return `${gate.name}:${step.label} — ${tail}`;
        }
      }
    }
    return null;
  }

  async #tryGateStep(
    step: BuildGate["steps"][number],
    cwd: string,
  ): Promise<{ readonly ok: boolean; readonly output: string }> {
    try {
      const result = await this.runner.run(step.command, {
        cwd,
        ...(step.timeoutMs !== undefined && { timeoutMs: step.timeoutMs }),
      });
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        output: result.timedOut
          ? `timed out after ${step.timeoutMs}ms`
          : result.stderr || result.stdout,
      };
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
