import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { decodeCursor } from "./cursor.render";
import {
  cleanupSandboxes,
  drain,
  dryRunTickRecords,
  freshStatus,
  logLine,
  NOW,
  newProjectsDir,
  STREAM_ID,
  seed,
  seedRecords,
  seedResolved,
  TODAY,
  TRACE_ID,
  testDeps,
} from "./fixtures/stream.fixture";
import { StreamService } from "./stream.service";

afterEach(cleanupSandboxes);

/** score: healthy, fully seeded. beta: job 777, stale heartbeat, no config entry. */
function seedFleet(dir: string): void {
  seedResolved(dir, "score");
  seed(dir, "score", "status.json", freshStatus());
  seedRecords(dir, "score", TODAY, dryRunTickRecords("score"));
  seed(
    dir,
    "score",
    `logs/${TODAY}.log`,
    logLine(`${TODAY}T11:59:00.000Z`, "info", "tick 7 starting") +
      logLine(`${TODAY}T11:59:20.000Z`, "info", "tick 7 complete"),
  );
  seed(
    dir,
    "beta",
    "status.json",
    JSON.stringify({
      state: "running",
      pid: 777,
      tick: 3,
      last_pass_started_at: null,
      last_pass_completed_at: null,
      last_error: null,
      // Free gate text can carry paths; it must never surface in a snapshot.
      last_gate_failure: "gate failed at /secret/checkout/path",
      updated_at: `${TODAY}T10:00:00.000Z`,
    }),
  );
}

function fleetDeps(dir: string) {
  return testDeps(dir, {
    jobs: async () => [
      // Internal fleet services share the supervisor namespace but never
      // become snapshot projects.
      { key: "_server", loaded: true, pid: 4000 },
      { key: "score", loaded: true, pid: 4242 },
      { key: "beta", loaded: true, pid: 777 },
    ],
  });
}

async function frames(dir: string, search: string, lastEventId: string | null = null) {
  const outcome = await new StreamService(fleetDeps(dir)).open(
    new URLSearchParams(search),
    lastEventId,
  );
  if (outcome.kind !== "stream") throw new Error(`expected a stream, got ${outcome.reason}`);
  return await drain(outcome.frames);
}

test("golden transcript: snapshots, full replay, caught_up, clean close on follow=false", async () => {
  const dir = newProjectsDir();
  seedFleet(dir);
  const parsed = await frames(dir, "follow=false");

  expect(parsed.map((frame) => frame.event)).toEqual([
    "score.stream.hello",
    "score.snapshot.fleet",
    "score.snapshot.project",
    "score.snapshot.project",
    "score.telemetry.event",
    "score.telemetry.span",
    "score.telemetry.event",
    "score.telemetry.span",
    "score.telemetry.span",
    "score.log.record",
    "score.log.record",
    "score.stream.caught_up",
  ]);

  // Every envelope is stamped with the subscribe's read time and stream id,
  // and its id: line mirrors the envelope cursor.
  for (const frame of parsed) {
    expect(frame.envelope.api_version).toBe("v1");
    expect(frame.envelope.emitted_at).toBe(NOW);
    expect(frame.envelope.stream_id).toBe(STREAM_ID);
    expect(frame.id).toBe(frame.envelope.cursor);
  }

  const [hello, fleet, beta, score] = parsed;
  expect(hello?.envelope.data).toEqual({});
  expect(fleet?.envelope.data).toEqual({
    projects: [
      { project: "beta", enabled: null, health: { state: "stale", reasons: ["HEARTBEAT_STALE"] } },
      { project: "score", enabled: true, health: { state: "healthy", reasons: ["OK"] } },
    ],
  });
  expect(fleet?.envelope.warnings).toBeUndefined();

  expect(beta?.envelope.data).toEqual({
    project: "beta",
    enabled: null,
    supervisor: { loaded: true, pid: 777 },
    status: {
      state: "running",
      pid: 777,
      tick: 3,
      last_pass_started_at: null,
      last_pass_completed_at: null,
      updated_at: `${TODAY}T10:00:00.000Z`,
    },
    config: null,
    health: { state: "stale", reasons: ["HEARTBEAT_STALE"] },
    telemetry_watermark: [],
  });

  const telemetryMark = statSync(join(dir, "score", "telemetry", `${TODAY}.jsonl`)).size;
  const logMark = statSync(join(dir, "score", "logs", `${TODAY}.log`)).size;
  expect(score?.envelope.data).toEqual({
    project: "score",
    enabled: true,
    supervisor: { loaded: true, pid: 4242 },
    status: {
      state: "running",
      pid: 4242,
      tick: 7,
      last_pass_started_at: `${TODAY}T11:59:00.000Z`,
      last_pass_completed_at: `${TODAY}T11:59:20.000Z`,
      updated_at: `${TODAY}T11:59:30.000Z`,
    },
    config: { harness: "claude", model: "opus", tick_interval_ms: 60_000, max_parallel: 2 },
    health: { state: "healthy", reasons: ["OK"] },
    telemetry_watermark: [
      { source: "telemetry", segment: TODAY, byte_offset: telemetryMark },
      { source: "log", segment: TODAY, byte_offset: logMark },
    ],
  });

  // Replay data is the stored records byte-for-byte, then the log lines.
  expect(parsed.slice(4, 9).map((frame) => frame.envelope.data)).toEqual(
    dryRunTickRecords("score"),
  );
  expect(parsed[9]?.envelope.data).toEqual({
    project: "score",
    ts: `${TODAY}T11:59:00.000Z`,
    level: "info",
    body: "tick 7 starting",
  });

  // caught_up's cursor rests at every captured mark.
  const boundary = parsed.at(-1);
  expect(boundary?.envelope.data).toEqual({});
  expect(decodeCursor(boundary?.envelope.cursor ?? "")).toEqual([
    { project: "score", source: "telemetry", segment: TODAY, byte_offset: telemetryMark },
    { project: "score", source: "log", segment: TODAY, byte_offset: logMark },
  ]);

  // The never-present list: the sandbox path (also an env-shaped value) and
  // free gate text never enter the wire.
  const text = JSON.stringify(parsed);
  expect(text).not.toContain(dir);
  expect(text).not.toContain("/secret/checkout");
});

test("trace filter replays one issue's tick across phases, snapshots excluded by signals", async () => {
  const dir = newProjectsDir();
  seedFleet(dir);
  const parsed = await frames(
    dir,
    `projects=score&signals=event,span&trace_id=${TRACE_ID}&follow=false`,
  );
  expect(parsed.map((frame) => frame.event)).toEqual([
    "score.stream.hello",
    "score.telemetry.event",
    "score.telemetry.span",
    "score.telemetry.event",
    "score.telemetry.span",
    "score.telemetry.span",
    "score.stream.caught_up",
  ]);
  const names = parsed.slice(1, -1).map((frame) => (frame.envelope.data as { name: string }).name);
  expect(names).toEqual([
    "score.dispatch.decision",
    "score.phase",
    "score.landing.decision",
    "score.phase",
    "score.tick",
  ]);
});

test("subject filter narrows to the one issue's decisions", async () => {
  const dir = newProjectsDir();
  seedFleet(dir);
  const parsed = await frames(
    dir,
    "projects=score&signals=event&subject_kind=issue&subject_id=40&follow=false",
  );
  expect(parsed.map((frame) => frame.event)).toEqual([
    "score.stream.hello",
    "score.telemetry.event",
    "score.stream.caught_up",
  ]);
  const decision = parsed[1]?.envelope.data as { subject?: unknown } | undefined;
  expect(decision?.subject).toEqual({ issue_number: 40 });
});

test("log-record replay: signals=log carries only the dated prose lines", async () => {
  const dir = newProjectsDir();
  seedFleet(dir);
  const parsed = await frames(dir, "projects=score&signals=log&follow=false");
  expect(parsed.map((frame) => frame.event)).toEqual([
    "score.stream.hello",
    "score.log.record",
    "score.log.record",
    "score.stream.caught_up",
  ]);
});

test("unreadable owners degrade snapshots with explicit warnings, never a crash", async () => {
  const dir = newProjectsDir();
  seedFleet(dir);
  // Config unparseable and the supervisor unreachable at once: both facts
  // ride every snapshot instead of posing as an empty-but-complete fleet.
  const outcome = await new StreamService(
    testDeps(dir, { readConfig: async () => null, jobs: async () => null }),
  ).open(new URLSearchParams("follow=false"), null);
  if (outcome.kind !== "stream") throw new Error("expected a stream");
  const frames = await drain(outcome.frames);
  const fleet = frames[1];
  expect(fleet?.event).toBe("score.snapshot.fleet");
  expect(fleet?.envelope.warnings).toEqual([
    { reason: "CONFIG_UNPARSEABLE" },
    { reason: "SUPERVISOR_UNREADABLE" },
  ]);
  const data = fleet?.envelope.data as { projects: { enabled: null }[] } | undefined;
  expect(data?.projects[0]?.enabled).toBeNull();
  const project = frames[2];
  expect(project?.event).toBe("score.snapshot.project");
  expect(project?.envelope.warnings).toEqual(fleet?.envelope.warnings);
});

test("trace-filtered caught_up still rests at the captured marks", async () => {
  const dir = newProjectsDir();
  seedFleet(dir);
  // Only one record of the trace is a landing decision; everything after it
  // is filtered out, yet the boundary cursor must sit at the marks.
  const parsed = await frames(
    dir,
    "projects=score&signals=event&names=score.landing.decision&follow=false",
  );
  const boundary = parsed.at(-1);
  expect(boundary?.event).toBe("score.stream.caught_up");
  expect(decodeCursor(boundary?.envelope.cursor ?? "")).toEqual([
    {
      project: "score",
      source: "telemetry",
      segment: TODAY,
      byte_offset: statSync(join(dir, "score", "telemetry", `${TODAY}.jsonl`)).size,
    },
  ]);
});

test("errors before any event: unknown filter 400, bad cursor 400, expired cursor 410", async () => {
  const dir = newProjectsDir();
  seedFleet(dir);
  const service = new StreamService(fleetDeps(dir));
  expect(await service.open(new URLSearchParams("verbose=1"), null)).toEqual({
    kind: "error",
    status: 400,
    reason: "FILTER_UNKNOWN",
  });
  expect(await service.open(new URLSearchParams(), "not-a-cursor")).toEqual({
    kind: "error",
    status: 400,
    reason: "CURSOR_UNPARSEABLE",
  });
  const expired = Buffer.from(
    JSON.stringify([
      { project: "score", source: "telemetry", segment: "2026-08-01", byte_offset: 0 },
    ]),
  ).toString("base64url");
  expect(await service.open(new URLSearchParams(), expired)).toEqual({
    kind: "error",
    status: 410,
    reason: "CURSOR_EXPIRED",
  });
});
