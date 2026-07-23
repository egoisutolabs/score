import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LandingResult } from "@/features/landing/change";

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

/** The latest build-red note from a landing tick, or null when the tick was green. */
export function gateFailureFrom(results: readonly LandingResult[]): string | null {
  return results.filter((result) => result.tag === "build-red").at(-1)?.note ?? null;
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
