import type { StatusFile } from "@score/core/daemon/status.service";
import { type Health, healthFor } from "@score/core/observation/health.policy";
import type { JobStatus } from "@score/core/supervisor/supervisor-adapter.interface";
import { describe, expect, it } from "vitest";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const TICK = 60_000;

function status(partial: Partial<StatusFile> = {}): StatusFile {
  return {
    state: "running",
    pid: 123,
    tick: 7,
    last_pass_started_at: null,
    last_pass_completed_at: null,
    last_error: null,
    last_gate_failure: null,
    updated_at: new Date(NOW - 1000).toISOString(),
    ...partial,
  };
}

const runningJob: JobStatus = { key: "p", loaded: true, pid: 123 };
const crashedJob: JobStatus = { key: "p", loaded: true };
const stoppedJob: JobStatus = { key: "p", loaded: false };

describe("healthFor", () => {
  // Each reason code produced from its deriveDot fixture in
  // apps/web/src/fleet/dot.policy.test.ts — the 1:1 mapping the epic locks.
  const table: [string, JobStatus | undefined, StatusFile | null, Health][] = [
    ["healthy heartbeat", runningJob, status(), { state: "healthy", reasons: ["OK"] }],
    [
      "heartbeat older than 2 ticks",
      runningJob,
      status({ updated_at: new Date(NOW - 2 * TICK - 1).toISOString() }),
      { state: "stale", reasons: ["HEARTBEAT_STALE"] },
    ],
    [
      "garbled updated_at",
      runningJob,
      status({ updated_at: "not-a-date" }),
      { state: "stale", reasons: ["HEARTBEAT_STALE"] },
    ],
    [
      "unreadable status while running",
      runningJob,
      null,
      { state: "stale", reasons: ["STATUS_MISSING"] },
    ],
    [
      "replacement pid, predecessor's fresh status",
      runningJob,
      status({ pid: 999 }),
      { state: "stale", reasons: ["PID_MISMATCH"] },
    ],
    [
      "last_error while running",
      runningJob,
      status({ last_error: "boom" }),
      { state: "crashed", reasons: ["CRASHED_LOADED_JOB"] },
    ],
    [
      "registered but pid gone (crash)",
      crashedJob,
      status(),
      { state: "crashed", reasons: ["CRASHED_LOADED_JOB"] },
    ],
    [
      "stopping",
      runningJob,
      status({ state: "stopping" }),
      { state: "stopped", reasons: ["STOPPING"] },
    ],
    [
      "registered, clean shutdown",
      crashedJob,
      status({ state: "stopping" }),
      { state: "stopped", reasons: ["STOPPING"] },
    ],
    [
      "deliberately stopped, stale running status",
      stoppedJob,
      status(),
      { state: "stopped", reasons: ["DISABLED"] },
    ],
    ["not installed at all", undefined, null, { state: "stopped", reasons: ["DISABLED"] }],
  ];

  for (const [name, job, file, expected] of table) {
    it(`${name} -> ${expected.reasons[0]}`, () => {
      expect(healthFor({ job, status: file, tickIntervalMs: TICK, nowMs: NOW })).toEqual(expected);
    });
  }
});
