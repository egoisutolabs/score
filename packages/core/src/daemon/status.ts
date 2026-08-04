import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LandingResult } from "@score/core/landing/change";

export type DaemonState = "starting" | "running" | "stopping";

/**
 * Machine-readable heartbeat for the supervisor and TUI. This schema is the
 * integration contract with issues #5 and #7 — additive changes only.
 */
export interface StatusFile {
  readonly state: DaemonState;
  readonly pid: number;
  readonly tick: number | null;
  readonly last_pass_started_at: string | null;
  readonly last_pass_completed_at: string | null;
  readonly last_error: string | null;
  readonly last_gate_failure: string | null;
  readonly updated_at: string;
}

/** Tags that only appear after #runGates ran the local gates and they passed. */
const GREEN_GATE_TAGS: ReadonlySet<string> = new Set(["soaking", "ready", "merged"]);

/**
 * The gate verdict a landing tick produced, if any: the latest build-red
 * tail, null when local gates ran and were green, undefined when no gates ran
 * this tick — skipped/conflict/checks-pending ticks never supersede the last
 * known failure, so callers keep the previous value on undefined.
 */
export function gateFailureFrom(results: readonly LandingResult[]): string | null | undefined {
  const failure = results.filter((result) => result.tag === "build-red").at(-1)?.note;
  if (failure !== undefined) return failure;
  return results.some((result) => GREEN_GATE_TAGS.has(result.tag)) ? null : undefined;
}

/**
 * Per-PR build-red verdicts landing hands to repair (epic decision 11).
 * Same standing semantics as gateFailureFrom: build-red sets, a green gate run
 * clears, a tick where gates never ran (skipped/conflict/checks-pending) keeps
 * the last verdict, and a PR absent from the candidates (closed, merged,
 * label-skipped) is forgotten.
 */
export function applyGateVerdicts(
  verdicts: Map<number, string>,
  results: readonly LandingResult[],
): void {
  const live = new Set(results.map((result) => result.pullRequestNumber));
  for (const number of verdicts.keys()) {
    if (!live.has(number)) verdicts.delete(number);
  }
  for (const result of results) {
    if (result.tag === "build-red") verdicts.set(result.pullRequestNumber, result.note);
    else if (GREEN_GATE_TAGS.has(result.tag)) verdicts.delete(result.pullRequestNumber);
  }
}

/**
 * Single-writer status heartbeat. Each write merges into the last full
 * snapshot and lands via tmp + rename, so a reader polling mid-write always
 * parses a complete file. Writes are chained in order; settle() flushes the
 * tail before the process exits.
 */
export class StatusWriter {
  #current: StatusFile;
  #chain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    this.#current = {
      state: "starting",
      pid: process.pid,
      tick: null,
      last_pass_started_at: null,
      last_pass_completed_at: null,
      last_error: null,
      last_gate_failure: null,
      updated_at: new Date().toISOString(),
    };
  }

  write(partial: Partial<Omit<StatusFile, "pid" | "updated_at">>): Promise<void> {
    this.#current = { ...this.#current, ...partial, updated_at: new Date().toISOString() };
    const snapshot = this.#current;
    const next = this.#chain.then(async () => {
      const tmp = `${this.path}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
      await rename(tmp, this.path);
    });
    // A failed write surfaces to its caller but must not poison later writes.
    this.#chain = next.catch(() => {});
    return next;
  }

  settle(): Promise<void> {
    return this.#chain;
  }
}
