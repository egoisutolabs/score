import type { StatusFile } from "@/features/daemon/status";
import type { JobStatus } from "@/features/supervisor/adapter";

export type Dot = "green" | "amber" | "gray" | "red";

export interface DotInput {
  /** Supervisor's view of the job; undefined = not installed at all. */
  readonly job: JobStatus | undefined;
  /** Parsed status.json; null = missing, unreadable, or partial. */
  readonly status: StatusFile | null;
  readonly tickIntervalMs: number;
  readonly nowMs: number;
}

/** Heartbeat older than ~2 ticks means the daemon stopped writing. */
const STALE_TICKS = 2;

/**
 * Dot semantics per the epic's lifecycle diagram: the adapter says the process
 * exists, heartbeat age says it's healthy, state/last_error distinguish
 * stopping from crashed. A registered job with no live pid crashed (launchd
 * keeps crashed jobs loaded); a booted-out job (not loaded) was deliberately
 * stopped, so it's gray even if the last snapshot still says "running".
 */
export function deriveDot({ job, status, tickIntervalMs, nowMs }: DotInput): Dot {
  if (job?.pid === undefined) {
    if (job?.loaded === true && status?.state !== "stopping") return "red";
    return "gray";
  }
  // Unreadable/partial status is stale, never a crash — atomic writes are
  // issue 4's guarantee; this is belt-and-braces.
  if (status === null) return "amber";
  if (status.last_error !== null) return "red";
  if (status.state === "stopping") return "gray";
  const age = nowMs - Date.parse(status.updated_at);
  // NaN age compares false and lands amber.
  if (age <= STALE_TICKS * tickIntervalMs) return "green";
  return "amber";
}
