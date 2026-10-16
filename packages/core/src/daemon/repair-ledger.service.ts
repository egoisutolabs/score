import { repairSessionName } from "@score/core/dispatch/dispatch.identity";
import type { RepairDefects, RepairExhaustion, WaveRecord } from "@score/core/repair/repair.policy";
import type { RepairResult } from "@score/core/repair/repair-result.interface";

interface RepairLedgerEntry {
  readonly tick: number;
  readonly headSha: string | undefined;
  readonly defects: RepairDefects;
  readonly sessionName: string;
  /** Every ping or spawn sent for this PR since it was last clean. */
  readonly waves: readonly WaveRecord[];
  /** The exhaustion label was put on (or seen on) this PR; its removal grants a fresh budget. */
  readonly labeled: boolean;
}

function sameDefects(a: RepairDefects, b: RepairDefects): boolean {
  return (
    a.conflicting === b.conflicting &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.failingChecks === b.failingChecks &&
    a.buildRed === b.buildRed
  );
}

export interface RepairLedgerOptions {
  /** Ticks after which a silent, unchanged agent is pinged again. */
  readonly staleTicks: number;
  /** Managed mode's project key: spawned repairs are recorded under the
   * namespaced session name the adapters actually create, so the liveness
   * check matches and the next tick does not tear down a live repair. */
  readonly namespace?: string;
  /** Pings or spawns a PR may receive before repair parks it for a human. */
  readonly roundBudget?: number;
  readonly now?: () => string;
}

/**
 * Repair runs every tick, so the guard against re-pinging a PR is not a timer
 * but "the agent I already pinged is still working on it": its session is
 * alive, nothing has been pushed, and the defects have not changed. Any of
 * those flipping — or `staleTicks` passing — earns another ping, until the
 * PR's round budget is spent.
 *
 * In-memory on purpose, like landing's soak counters: a restart costs at most
 * one extra ping — and, until the ledger is persisted, one fresh budget for a
 * PR whose exhaustion label never landed.
 */
export class RepairLedger {
  readonly #entries = new Map<number, RepairLedgerEntry>();
  readonly #pending = new Map<number, { headSha?: string; defects: RepairDefects }>();
  readonly #options: Required<RepairLedgerOptions>;
  #tick = 0;
  #liveSessions: ReadonlySet<string> = new Set();

  constructor(options: RepairLedgerOptions) {
    this.#options = {
      staleTicks: options.staleTicks,
      namespace: options.namespace ?? "",
      roundBudget: options.roundBudget ?? Number.POSITIVE_INFINITY,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  /** Call once before each repair pass with the tick and the live tmux sessions. */
  startPass(tick: number, liveSessions: ReadonlySet<string>): void {
    this.#tick = tick;
    this.#liveSessions = liveSessions;
    this.#pending.clear();
  }

  /**
   * RepairService's `exhaustion`: the spent budget, or undefined while rounds
   * remain. A PR whose label a human removed starts over with an empty wave
   * history — that removal is the only way to grant another budget.
   */
  exhaustion(pullRequestNumber: number, labeled: boolean): RepairExhaustion | undefined {
    const entry = this.#entries.get(pullRequestNumber);
    if (!entry) return undefined;
    if (entry.labeled && !labeled) {
      this.#entries.delete(pullRequestNumber);
      return undefined;
    }
    if (entry.waves.length < this.#options.roundBudget) return undefined;
    return { budget: this.#options.roundBudget, waves: entry.waves };
  }

  /** RepairService's `shouldAct`: false while the agent on this PR is still working. */
  shouldAct(pullRequestNumber: number, defects: RepairDefects, headSha?: string): boolean {
    this.#pending.set(pullRequestNumber, { headSha, defects });
    const entry = this.#entries.get(pullRequestNumber);
    if (!entry || entry.waves.length === 0) return true;
    // An absent headSha compares equal to an absent one, so a PR whose sha we
    // never learned is bounded by staleTicks rather than pinged every tick.
    const working =
      this.#liveSessions.has(entry.sessionName) &&
      entry.headSha === headSha &&
      sameDefects(entry.defects, defects) &&
      this.#tick - entry.tick < this.#options.staleTicks;
    return !working;
  }

  /** Call with the pass's results: records what was acted on, forgets the rest. */
  finishPass(results: readonly RepairResult[]): void {
    const seen = new Set<number>();
    for (const result of results) {
      seen.add(result.pullRequestNumber);
      const entry = this.#entries.get(result.pullRequestNumber);
      if (result.action === "EXHAUSTED") {
        // Seen or put on: either way the label now governs this PR.
        if (!result.dryRun) {
          this.#entries.set(result.pullRequestNumber, {
            tick: entry?.tick ?? this.#tick,
            headSha: entry?.headSha,
            defects: entry?.defects ?? {
              conflicting: false,
              unresolvedThreads: 0,
              failingChecks: 0,
            },
            sessionName: entry?.sessionName ?? "",
            waves: entry?.waves ?? [],
            labeled: true,
          });
        }
        continue;
      }
      if (result.action !== "PINGED" && result.action !== "SPAWNED") {
        // WORKING and CHECKS_PENDING keep their entry — the wave count must
        // survive a wait; anything else means this PR is no longer one we are
        // waiting on, and its budget starts over the next time it breaks.
        if (result.action !== "WORKING" && result.action !== "CHECKS_PENDING") {
          this.#entries.delete(result.pullRequestNumber);
        }
        continue;
      }
      // A dry run reports what it would do without touching a session, so
      // recording it would silence the next pass for no reason.
      const pending = result.dryRun ? undefined : this.#pending.get(result.pullRequestNumber);
      if (!pending) continue;
      const wave: WaveRecord = {
        at: this.#options.now(),
        tick: this.#tick,
        headSha: pending.headSha,
        defects: pending.defects,
      };
      this.#entries.set(result.pullRequestNumber, {
        tick: this.#tick,
        headSha: pending.headSha,
        defects: pending.defects,
        sessionName:
          result.action === "PINGED"
            ? (result.target ?? "")
            : repairSessionName(this.#options.namespace || undefined, result.pullRequestNumber),
        waves: [...(entry?.waves ?? []), wave],
        labeled: false,
      });
    }
    for (const number of this.#entries.keys()) {
      if (!seen.has(number)) this.#entries.delete(number);
    }
  }
}
