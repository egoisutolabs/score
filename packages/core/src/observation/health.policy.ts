import type { StatusFile } from "../daemon/status.service";
import type { JobStatus } from "../supervisor/supervisor-adapter.interface";

export type HealthReason =
  | "OK"
  | "PID_MISMATCH"
  | "HEARTBEAT_STALE"
  | "CRASHED_LOADED_JOB"
  | "STOPPING"
  | "STATUS_MISSING"
  | "DISABLED";

export type HealthState = "healthy" | "stale" | "crashed" | "stopped";

export interface Health {
  readonly state: HealthState;
  readonly reasons: readonly HealthReason[];
}

export interface HealthInput {
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
 * Health semantics per the epic's lifecycle diagram: the adapter says the
 * process exists, heartbeat age says it's healthy, state/last_error
 * distinguish stopping from crashed. A registered job with no live pid
 * crashed (launchd keeps crashed jobs loaded); a booted-out job (not loaded)
 * was deliberately stopped, so it's stopped even if the last snapshot still
 * says "running". Reason-coded so surfaces (TUI dot, snapshot stream) can
 * map the decision without re-deriving it.
 */
export function healthFor({ job, status, tickIntervalMs, nowMs }: HealthInput): Health {
  if (job?.pid === undefined) {
    if (job?.loaded === true && status?.state !== "stopping") {
      return { state: "crashed", reasons: ["CRASHED_LOADED_JOB"] };
    }
    if (job?.loaded === true) return { state: "stopped", reasons: ["STOPPING"] };
    return { state: "stopped", reasons: ["DISABLED"] };
  }
  // Unreadable/partial status is stale, never a crash — atomic writes are
  // issue 4's guarantee; this is belt-and-braces.
  if (status === null) return { state: "stale", reasons: ["STATUS_MISSING"] };
  // A heartbeat certifies only the process that wrote it: after a restart the
  // predecessor's fresh status must not certify the replacement healthy.
  if (status.pid !== job.pid) return { state: "stale", reasons: ["PID_MISMATCH"] };
  // A live pid reporting last_error is a crashed pass, not a crashed process;
  // the enum's one crash code covers both — parity with deriveDot's red.
  if (status.last_error !== null) return { state: "crashed", reasons: ["CRASHED_LOADED_JOB"] };
  if (status.state === "stopping") return { state: "stopped", reasons: ["STOPPING"] };
  const age = nowMs - Date.parse(status.updated_at);
  // NaN age compares false and lands stale.
  if (age <= STALE_TICKS * tickIntervalMs) return { state: "healthy", reasons: ["OK"] };
  return { state: "stale", reasons: ["HEARTBEAT_STALE"] };
}
