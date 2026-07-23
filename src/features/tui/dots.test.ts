import { describe, expect, it } from "vitest";
import type { StatusFile } from "@/features/daemon/status";
import type { JobStatus } from "@/features/supervisor/adapter";
import { type Dot, deriveDot } from "@/features/tui/dots";

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

describe("deriveDot", () => {
  // Truth table over (job exists × heartbeat age × state × last_error),
  // per the epic's lifecycle diagram.
  const table: [string, JobStatus | undefined, StatusFile | null, Dot][] = [
    ["healthy heartbeat", runningJob, status(), "green"],
    ["starting, fresh heartbeat", runningJob, status({ state: "starting" }), "green"],
    [
      "heartbeat just inside 2 ticks",
      runningJob,
      status({ updated_at: new Date(NOW - 2 * TICK).toISOString() }),
      "green",
    ],
    [
      "heartbeat older than 2 ticks",
      runningJob,
      status({ updated_at: new Date(NOW - 2 * TICK - 1).toISOString() }),
      "amber",
    ],
    ["unreadable status while running", runningJob, null, "amber"],
    ["garbled updated_at", runningJob, status({ updated_at: "not-a-date" }), "amber"],
    ["last_error while running", runningJob, status({ last_error: "boom" }), "red"],
    ["stopping", runningJob, status({ state: "stopping" }), "gray"],
    ["registered but pid gone (crash)", crashedJob, status(), "red"],
    ["registered, no pid, no status yet", crashedJob, null, "red"],
    ["registered, clean shutdown", crashedJob, status({ state: "stopping" }), "gray"],
    ["deliberately stopped, stale running status", stoppedJob, status(), "gray"],
    ["not installed at all", undefined, null, "gray"],
    ["not installed, leftover status", undefined, status(), "gray"],
  ];

  for (const [name, job, file, expected] of table) {
    it(`${name} -> ${expected}`, () => {
      expect(deriveDot({ job, status: file, tickIntervalMs: TICK, nowMs: NOW })).toBe(expected);
    });
  }
});
