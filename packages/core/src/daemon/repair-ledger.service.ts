import { repairSessionName } from "@score/core/dispatch/dispatch.identity";
import { REPAIR_PROMPT_VERSION } from "@score/core/prompts/repair.render";
import { convergenceVerdict } from "@score/core/repair/convergence/convergence.policy";
import type { FindingLedger, FindingRecord } from "@score/core/repair/findings/finding.interface";
import type { RepairDefects, RepairExhaustion, WaveRecord } from "@score/core/repair/repair.policy";
import type { RepairResult } from "@score/core/repair/repair-result.interface";

export interface RepairLedgerEntry {
  readonly tick: number;
  readonly headSha: string | undefined;
  readonly defects: RepairDefects;
  readonly sessionName: string;
  /** Every ping or spawn sent for this PR since it was last clean. */
  readonly waves: readonly WaveRecord[];
  /** The exhaustion label was put on (or seen on) this PR; its removal grants a fresh budget. */
  readonly labeled: boolean;
  /** Head when the first wave was sent; blame after it is a regression from a fix. */
  readonly firstHead: string | undefined;
  readonly findings: readonly FindingRecord[];
  /** When the PR was first seen clean with its checks reported; absent while anything is wrong or pending. */
  readonly cleanSince?: string;
  /** The head that clock is for: a push whose checks finished between passes still restarts it. */
  readonly cleanHead?: string;
}

/** The on-disk shape; additive changes only, bump `v` for anything else. */
export interface RepairLedgerSnapshot {
  readonly v: 1;
  readonly pullRequests: Readonly<Record<string, RepairLedgerEntry>>;
}

const NO_DEFECTS: RepairDefects = { conflicting: false, unresolvedThreads: 0, failingChecks: 0 };

/**
 * A fresh budget (the PR went clean, or a human removed the label) keeps the
 * findings as history but ends the repair episode they belonged to: a record
 * still marked as blaming to "the last fix" would otherwise re-park the PR
 * (convergence rule 3) as soon as the new episode's wave count caught up
 * with the wave the old record was seen at.
 */
function freshBudget(entry: RepairLedgerEntry): RepairLedgerEntry {
  const { cleanSince: _, cleanHead: __, ...rest } = entry;
  return {
    ...rest,
    waves: [],
    labeled: false,
    findings: entry.findings.map((record) =>
      record.fromLastFix ? { ...record, fromLastFix: false } : record,
    ),
  };
}

function sameDefects(a: RepairDefects, b: RepairDefects): boolean {
  return (
    a.conflicting === b.conflicting &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.failingChecks === b.failingChecks &&
    a.buildRed === b.buildRed
  );
}

export interface RepairPassContext {
  /**
   * Landing's last due pass did not run to completion (suppressed while an
   * unreconciled commit sits ahead of origin, or it threw), so no head it
   * would settle is being timed: the clean clock neither starts nor advances
   * until landing runs again.
   */
  readonly landingIdle?: boolean;
  /**
   * The PRs landing's last completed pass noted heads for. A PR outside it
   * (a draft, a hold label) is not being settled by landing either, so its
   * clock is held the same way; omitted, landing's view is unknown and the
   * clock runs on repair's own observations.
   */
  readonly landingObserved?: ReadonlySet<number>;
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
  /**
   * How long a PR must stay clean, checks reported, before its wave history
   * resets. Codex posts no check run, so "every check reported and nothing
   * is wrong" does not mean the review round is over (analysis §2.5): a
   * finding it posts inside landing's settle window must meet the budget
   * the earlier waves spent, not a fresh one. Zero resets at once.
   */
  readonly settleMs?: number;
  readonly now?: () => string;
}

/**
 * Repair runs every tick, so the guard against re-pinging a PR is not a timer
 * but "the agent I already pinged is still working on it": its session is
 * alive, nothing has been pushed, and the defects have not changed. Any of
 * those flipping — or `staleTicks` passing — earns another ping, until the
 * PR's round budget is spent.
 *
 * The daemon persists it through snapshot()/restore() (RepairLedgerStore), so
 * a restart keeps every PR's budget, wave history, and keyed findings. The
 * manual subcommand runs without one.
 */
export class RepairLedger implements FindingLedger {
  #entries = new Map<number, RepairLedgerEntry>();
  readonly #pending = new Map<
    number,
    { headSha?: string; defects: RepairDefects; diffSize?: number }
  >();
  readonly #options: Required<RepairLedgerOptions>;
  #tick = 0;
  #liveSessions: ReadonlySet<string> = new Set();

  constructor(options: RepairLedgerOptions) {
    this.#options = {
      staleTicks: options.staleTicks,
      namespace: options.namespace ?? "",
      roundBudget: options.roundBudget ?? Number.POSITIVE_INFINITY,
      settleMs: options.settleMs ?? 0,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  snapshot(): RepairLedgerSnapshot {
    return {
      v: 1,
      pullRequests: Object.fromEntries(
        [...this.#entries].map(([number, entry]) => [String(number), entry]),
      ),
    };
  }

  /**
   * Ticks restart at zero with the process, so a restored entry's tick is
   * clamped to zero: a live, unchanged agent is left alone for one more
   * staleTicks window rather than for the whole gap the old tick would imply.
   *
   * The clean clock restarts too: landing keeps its settle clock in memory, so
   * after a restart it waits a whole window again, and a clock restored from
   * before the restart would reset the budget while landing still waits.
   */
  restore(snapshot: RepairLedgerSnapshot): void {
    this.#entries = new Map(
      Object.entries(snapshot.pullRequests).map(([number, entry]) => {
        const { cleanSince: _, cleanHead: __, ...rest } = entry;
        return [Number(number), { ...rest, tick: 0 }];
      }),
    );
  }

  /** Call once before each repair pass with the tick and the live tmux sessions. */
  startPass(tick: number, liveSessions: ReadonlySet<string>): void {
    this.#tick = tick;
    this.#liveSessions = liveSessions;
    this.#pending.clear();
  }

  findings(pullRequestNumber: number): readonly FindingRecord[] {
    return this.#entries.get(pullRequestNumber)?.findings ?? [];
  }

  firstHead(pullRequestNumber: number): string | undefined {
    return this.#entries.get(pullRequestNumber)?.firstHead;
  }

  waveCount(pullRequestNumber: number): number {
    return this.#entries.get(pullRequestNumber)?.waves.length ?? 0;
  }

  lastWaveHead(pullRequestNumber: number): string | undefined {
    return this.lastWave(pullRequestNumber)?.headSha;
  }

  /** The most recent wave sent for this PR, for the wave telemetry record. */
  lastWave(pullRequestNumber: number): WaveRecord | undefined {
    return this.#entries.get(pullRequestNumber)?.waves.at(-1);
  }

  recordFindings(pullRequestNumber: number, records: readonly FindingRecord[]): void {
    const entry = this.#entries.get(pullRequestNumber) ?? this.#blank();
    this.#entries.set(pullRequestNumber, { ...entry, findings: records });
  }

  /**
   * Defects the convergence rules count as open: threads the reviewer still
   * holds open on GitHub, once per finding key — two reviewers raising the
   * same defect are one thing left to fix, not two. The agent's own resolves
   * are left out here on purpose: reviewer bots almost never resolve a thread
   * (one of 138 in the baseline), so a count that kept self-resolves open
   * could only ever grow, and "did not decrease over three waves" would park
   * every PR at its third wave whatever the agent did.
   */
  openFindingCount(pullRequestNumber: number): number {
    return this.#distinctKeys(pullRequestNumber, (record) => record.resolution === "open");
  }

  /**
   * Findings nobody but the agent has closed: GitHub-open plus self-resolved.
   * The "open at merge" figure the baseline counted by hand, where an agent's
   * own resolve is not a reviewer's confirmation.
   */
  unconfirmedFindingCount(pullRequestNumber: number): number {
    return this.#distinctKeys(
      pullRequestNumber,
      (record) => record.resolution !== "reviewer-resolved",
    );
  }

  #distinctKeys(pullRequestNumber: number, keep: (record: FindingRecord) => boolean): number {
    return new Set(
      this.findings(pullRequestNumber)
        .filter(keep)
        .map((record) => record.key),
    ).size;
  }

  /**
   * RepairService's `exhaustion`: the convergence verdict that parks this PR
   * (budget spent, findings flat, diff growing, or a regression from the last
   * fix — analysis §2.3), or undefined while the loop may continue. A PR whose
   * label a human removed starts over with an empty wave history — that
   * removal is the only way to grant another budget.
   */
  exhaustion(pullRequestNumber: number, labeled: boolean): RepairExhaustion | undefined {
    const entry = this.#entries.get(pullRequestNumber);
    if (!entry) return undefined;
    if (entry.labeled && !labeled) {
      this.#entries.set(pullRequestNumber, freshBudget(entry));
      return undefined;
    }
    const verdict = convergenceVerdict({
      waves: entry.waves,
      findings: entry.findings,
      budget: this.#options.roundBudget,
    });
    if (verdict === undefined) return undefined;
    return { budget: this.#options.roundBudget, waves: entry.waves, ...verdict };
  }

  /** RepairService's `shouldAct`: false while the agent on this PR is still working. */
  shouldAct(
    pullRequestNumber: number,
    defects: RepairDefects,
    headSha?: string,
    diffSize?: number,
  ): boolean {
    this.#pending.set(pullRequestNumber, { headSha, defects, diffSize });
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

  /**
   * Call with the pass's results. A PR that went clean keeps its findings and
   * first head (history) but starts a fresh budget once it has stayed clean
   * for settleMs; a PR no longer reported (merged or closed) is forgotten
   * entirely. A PR the pass could not judge (checks pending, thread query
   * failed, agent still working) or could not reach (defective, but no
   * session and no worktree to send to) is held as is.
   */
  finishPass(results: readonly RepairResult[], pass: RepairPassContext = {}): void {
    const seen = new Set<number>();
    for (const result of results) {
      seen.add(result.pullRequestNumber);
      let entry = this.#entries.get(result.pullRequestNumber) ?? this.#blank();
      // Anything but a clean pass on the same head restarts the clean clock: a
      // push usually shows as pending checks first, but a head whose checks
      // finished between two passes shows only as a new sha on a clean result.
      // So does a pass landing sat out: its own clock has not started, and a
      // window counted here alone would reset the budget before landing's
      // settle, which the settle exists to cover.
      const newHead =
        result.headSha !== undefined &&
        entry.cleanHead !== undefined &&
        result.headSha !== entry.cleanHead;
      const unsettled =
        pass.landingIdle === true ||
        (pass.landingObserved !== undefined && !pass.landingObserved.has(result.pullRequestNumber));
      if (
        (result.action !== "NOT_NEEDED" || newHead || unsettled) &&
        entry.cleanSince !== undefined
      ) {
        const { cleanSince: _, cleanHead: __, ...rest } = entry;
        entry = rest;
        this.#entries.set(result.pullRequestNumber, entry);
      }
      if (result.action === "EXHAUSTED") {
        // Seen or put on: either way the label now governs this PR.
        if (!result.dryRun) {
          this.#entries.set(result.pullRequestNumber, { ...entry, labeled: true });
        }
        continue;
      }
      if (
        result.action === "WORKING" ||
        result.action === "CHECKS_PENDING" ||
        result.action === "UNOBSERVED" ||
        result.action === "SKIPPED"
      ) {
        continue;
      }
      if (result.action !== "PINGED" && result.action !== "SPAWNED") {
        if (unsettled && this.#options.settleMs > 0) continue;
        if (entry.waves.length > 0 || entry.labeled) {
          const now = this.#options.now();
          const cleanSince = entry.cleanSince ?? now;
          if (
            this.#options.settleMs > 0 &&
            Date.parse(now) - Date.parse(cleanSince) < this.#options.settleMs
          ) {
            this.#entries.set(result.pullRequestNumber, {
              ...entry,
              cleanSince,
              ...(result.headSha !== undefined && { cleanHead: result.headSha }),
            });
            continue;
          }
          this.#entries.set(result.pullRequestNumber, freshBudget(entry));
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
        // Findings were observed earlier in this same pass, so this is the
        // count the agent is being sent to bring down.
        openFindings: this.openFindingCount(result.pullRequestNumber),
        diffSize: pending.diffSize,
        promptVersion: REPAIR_PROMPT_VERSION,
      };
      this.#entries.set(result.pullRequestNumber, {
        ...entry,
        tick: this.#tick,
        headSha: pending.headSha,
        defects: pending.defects,
        sessionName:
          result.action === "PINGED"
            ? (result.target ?? "")
            : repairSessionName(this.#options.namespace || undefined, result.pullRequestNumber),
        waves: [...entry.waves, wave],
        labeled: false,
        firstHead: entry.waves.length === 0 ? pending.headSha : entry.firstHead,
      });
    }
    for (const number of this.#entries.keys()) {
      if (!seen.has(number)) this.#entries.delete(number);
    }
  }

  #blank(): RepairLedgerEntry {
    return {
      tick: this.#tick,
      headSha: undefined,
      defects: NO_DEFECTS,
      sessionName: "",
      waves: [],
      labeled: false,
      firstHead: undefined,
      findings: [],
    };
  }
}
