import type { RepairDefects } from "@/features/repair/policy";
import type { RepairResult } from "@/features/repair/result";

interface RepairLedgerEntry {
  readonly tick: number;
  readonly headSha: string | undefined;
  readonly defects: RepairDefects;
  readonly sessionName: string;
}

function sameDefects(a: RepairDefects, b: RepairDefects): boolean {
  return (
    a.conflicting === b.conflicting &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.failingChecks === b.failingChecks
  );
}

/**
 * Repair runs every tick, so the guard against re-pinging a PR is not a timer
 * but "the agent I already pinged is still working on it": its session is
 * alive, nothing has been pushed, and the defects have not changed. Any of
 * those flipping — or `staleTicks` passing — earns another ping.
 *
 * In-memory on purpose, like landing's soak counters: a restart costs at most
 * one extra ping.
 */
export class RepairLedger {
  readonly #entries = new Map<number, RepairLedgerEntry>();
  readonly #pending = new Map<number, { headSha?: string; defects: RepairDefects }>();
  #tick = 0;
  #liveSessions: ReadonlySet<string> = new Set();

  constructor(private readonly staleTicks: number) {}

  /** Call once before each repair pass with the tick and the live tmux sessions. */
  startPass(tick: number, liveSessions: ReadonlySet<string>): void {
    this.#tick = tick;
    this.#liveSessions = liveSessions;
    this.#pending.clear();
  }

  /** RepairService's `shouldAct`: false while the agent on this PR is still working. */
  shouldAct(pullRequestNumber: number, defects: RepairDefects, headSha?: string): boolean {
    this.#pending.set(pullRequestNumber, { headSha, defects });
    const entry = this.#entries.get(pullRequestNumber);
    if (!entry) return true;
    // An absent headSha compares equal to an absent one, so a PR whose sha we
    // never learned is bounded by staleTicks rather than pinged every tick.
    const working =
      this.#liveSessions.has(entry.sessionName) &&
      entry.headSha === headSha &&
      sameDefects(entry.defects, defects) &&
      this.#tick - entry.tick < this.staleTicks;
    return !working;
  }

  /** Call with the pass's results: records what was acted on, forgets the rest. */
  finishPass(results: readonly RepairResult[]): void {
    const seen = new Set<number>();
    for (const result of results) {
      seen.add(result.pullRequestNumber);
      if (result.action !== "PINGED" && result.action !== "SPAWNED") {
        // WORKING keeps its entry; anything else means this PR is no longer
        // one we are waiting on.
        if (result.action !== "WORKING") this.#entries.delete(result.pullRequestNumber);
        continue;
      }
      // A dry run reports what it would do without touching a session, so
      // recording it would silence the next pass for no reason.
      const pending = result.dryRun ? undefined : this.#pending.get(result.pullRequestNumber);
      if (!pending) continue;
      this.#entries.set(result.pullRequestNumber, {
        tick: this.#tick,
        headSha: pending.headSha,
        defects: pending.defects,
        sessionName:
          result.action === "PINGED"
            ? (result.target ?? "")
            : `shepherd-pr-${result.pullRequestNumber}`,
      });
    }
    for (const number of this.#entries.keys()) {
      if (!seen.has(number)) this.#entries.delete(number);
    }
  }
}
