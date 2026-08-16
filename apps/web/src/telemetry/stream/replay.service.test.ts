import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TelemetryCursor } from "@score/core/telemetry/telemetry.interface";
import { afterEach, expect, test } from "vitest";
import { cleanupSandboxes, newProjectsDir, seed, seedRecords } from "./fixtures/stream.fixture";
import type { StreamQuery } from "./query.policy";
import type { ReplayEmission } from "./replay.service";
import {
  captureMarks,
  initialCursor,
  planReplay,
  REPLAY_BATCH_LIMIT,
  replay,
  watermarkFor,
} from "./replay.service";

afterEach(cleanupSandboxes);

const ALL: StreamQuery = { follow: true };

function event(i: number): object {
  return {
    v: 1,
    ts: "2026-08-15T11:00:00.000Z",
    project: "score",
    signal: "event",
    name: "score.dispatch.decision",
    attributes: { decision: "started", n: i },
  };
}

function run(
  projectsDir: string,
  keys: readonly string[],
  sources: readonly ("telemetry" | "log")[],
  cursor?: readonly TelemetryCursor[],
  query: StreamQuery = ALL,
): readonly ReplayEmission[] {
  const marks = captureMarks(projectsDir, keys, sources);
  const plan = planReplay(marks, cursor);
  if (!plan.ok) throw new Error("unexpected CURSOR_EXPIRED");
  return [...replay(projectsDir, plan.pairs, query)];
}

function records(emissions: readonly ReplayEmission[]): readonly number[] {
  return emissions.flatMap((emission) =>
    emission.kind === "telemetry" ? [(emission.record.attributes as { n: number }).n] : [],
  );
}

test("batch cap: a mark spanning far more than 500 records arrives complete, in order", () => {
  const dir = newProjectsDir();
  const total = REPLAY_BATCH_LIMIT * 2 + 200;
  seedRecords(
    dir,
    "score",
    "2026-08-15",
    Array.from({ length: total }, (_, i) => event(i)),
  );
  const emissions = run(dir, ["score"], ["telemetry"]);
  expect(records(emissions)).toEqual(Array.from({ length: total }, (_, i) => i));
  expect(REPLAY_BATCH_LIMIT).toBe(500);
});

test("continuous writes: records appended after subscribe stay beyond the fixed mark", () => {
  const dir = newProjectsDir();
  seedRecords(
    dir,
    "score",
    "2026-08-15",
    Array.from({ length: 600 }, (_, i) => event(i)),
  );
  const marks = captureMarks(dir, ["score"], ["telemetry"]);
  const plan = planReplay(marks, undefined);
  if (!plan.ok) throw new Error("unexpected CURSOR_EXPIRED");
  const path = join(dir, "score", "telemetry", "2026-08-15.jsonl");
  // Writer keeps appending: before the first read and between batches.
  appendFileSync(path, `${JSON.stringify(event(9000))}\n`);
  const generator = replay(dir, plan.pairs, ALL);
  const first = generator.next().value as ReplayEmission;
  appendFileSync(path, `${JSON.stringify(event(9001))}\n`);
  const rest = [...generator];
  expect(records([first, ...rest])).toEqual(Array.from({ length: 600 }, (_, i) => i));
});

test("the incomplete tail is withheld — even once the writer completes it past the mark", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "score", "2026-08-15", [event(0)]);
  const path = join(dir, "score", "telemetry", "2026-08-15.jsonl");
  appendFileSync(path, '{"v":1,"torn');
  const marks = captureMarks(dir, ["score"], ["telemetry"]);
  const plan = planReplay(marks, undefined);
  if (!plan.ok) throw new Error("unexpected CURSOR_EXPIRED");
  appendFileSync(path, '":true}\n');
  const emissions = [...replay(dir, plan.pairs, ALL)];
  expect(records(emissions)).toEqual([0]);
  // The cursor stops at the last complete line, not the mark: the torn
  // bytes stay ahead of it for #82's resume.
  const last = emissions.at(-1);
  expect(last?.cursor).toEqual([
    {
      project: "score",
      source: "telemetry",
      segment: "2026-08-15",
      byte_offset: expect.any(Number),
    },
  ]);
});

test("an unparseable or unknown-version line warns once per segment and never drops neighbours", () => {
  const dir = newProjectsDir();
  seed(
    dir,
    "score",
    "telemetry/2026-08-15.jsonl",
    `${JSON.stringify(event(0))}\nnot json\n{"v":2,"name":"future"}\n${JSON.stringify(event(1))}\n`,
  );
  const emissions = run(dir, ["score"], ["telemetry"]);
  expect(records(emissions)).toEqual([0, 1]);
  expect(emissions.filter((emission) => emission.kind === "warning")).toEqual([
    expect.objectContaining({ reason: "RECORD_UNPARSEABLE" }),
  ]);
});

test("a segment deleted after capture warns SEGMENT_UNREADABLE and replay continues", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "score", "2026-08-14", [event(0)]);
  seedRecords(dir, "score", "2026-08-15", [event(1)]);
  const marks = captureMarks(dir, ["score"], ["telemetry"]);
  const plan = planReplay(marks, undefined);
  if (!plan.ok) throw new Error("unexpected CURSOR_EXPIRED");
  rmSync(join(dir, "score", "telemetry", "2026-08-14.jsonl"));
  const emissions = [...replay(dir, plan.pairs, ALL)];
  expect(emissions.map((emission) => emission.kind)).toEqual(["warning", "telemetry"]);
  expect(records(emissions)).toEqual([1]);
});

test("a presented cursor resumes after consumed records and skips consumed segments", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "score", "2026-08-14", [event(0), event(1)]);
  seedRecords(dir, "score", "2026-08-15", [event(2), event(3)]);
  const full = run(dir, ["score"], ["telemetry"]);
  // Resume from the composite cursor emitted with record 2.
  const at = full[2];
  if (at === undefined || at.kind === "warning") throw new Error("expected a record");
  const resumed = run(dir, ["score"], ["telemetry"], at.cursor);
  expect(records(resumed)).toEqual([3]);
});

test("a cursor offset landing mid-line drops the torn fragment and resyncs", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "score", "2026-08-15", [event(0), event(1)]);
  const emissions = run(
    dir,
    ["score"],
    ["telemetry"],
    [{ project: "score", source: "telemetry", segment: "2026-08-15", byte_offset: 3 }],
  );
  expect(records(emissions)).toEqual([1]);
});

test("cursor naming a deleted segment → CURSOR_EXPIRED before any event", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "score", "2026-08-15", [event(0)]);
  const marks = captureMarks(dir, ["score"], ["telemetry"]);
  // Older than every retained segment: retention removed it.
  expect(
    planReplay(marks, [
      { project: "score", source: "telemetry", segment: "2026-08-10", byte_offset: 0 },
    ]),
  ).toEqual({ ok: false, reason: "CURSOR_EXPIRED" });
  // Consumed bytes from a file that is gone entirely.
  expect(
    planReplay(captureMarks(dir, ["score"], ["log"]), [
      { project: "score", source: "log", segment: "2026-08-10", byte_offset: 12 },
    ]),
  ).toEqual({ ok: false, reason: "CURSOR_EXPIRED" });
});

test("cursor dated after every retained segment means fully consumed, not expired", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "score", "2026-08-15", [event(0)]);
  const emissions = run(
    dir,
    ["score"],
    ["telemetry"],
    [{ project: "score", source: "telemetry", segment: "2026-08-16", byte_offset: 0 }],
  );
  expect(emissions).toEqual([]);
});

test("log source: dated prose lines become records; a shapeless line warns", () => {
  const dir = newProjectsDir();
  seed(
    dir,
    "score",
    "logs/2026-08-15.log",
    "[2026-08-15T11:59:00.000Z] [info] tick 7 complete\nno shape here\n[2026-08-15T11:59:05.000Z] [warn] slow pass\n",
  );
  const emissions = run(dir, ["score"], ["log"]);
  expect(
    emissions.map((emission) => (emission.kind === "log" ? emission.record.level : emission.kind)),
  ).toEqual(["info", "warning", "warn"]);
  const first = emissions[0];
  if (first?.kind !== "log") throw new Error("expected a log record");
  expect(first.record).toEqual({
    project: "score",
    ts: "2026-08-15T11:59:00.000Z",
    level: "info",
    body: "tick 7 complete",
  });
});

test("filtered-out records advance the cursor without a frame", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "score", "2026-08-15", [event(0), event(1)]);
  const emissions = run(dir, ["score"], ["telemetry"], undefined, {
    follow: true,
    names: ["score.landing.decision"],
  });
  expect(emissions).toEqual([]);
});

test("composite cursor carries every positioned pair; a quiet pair keeps its place", () => {
  const dir = newProjectsDir();
  seedRecords(dir, "alpha", "2026-08-15", [event(0)]);
  seedRecords(dir, "beta", "2026-08-15", [event(1)]);
  seed(dir, "beta", "logs/2026-08-15.log", "[2026-08-15T11:00:00.000Z] [info] hello\n");
  const marks = captureMarks(dir, ["alpha", "beta"], ["telemetry", "log"]);
  const plan = planReplay(marks, undefined);
  if (!plan.ok) throw new Error("unexpected CURSOR_EXPIRED");
  expect(initialCursor(plan.pairs)).toEqual([
    { project: "alpha", source: "telemetry", segment: "2026-08-15", byte_offset: 0 },
    { project: "beta", source: "telemetry", segment: "2026-08-15", byte_offset: 0 },
    { project: "beta", source: "log", segment: "2026-08-15", byte_offset: 0 },
  ]);
  const emissions = [...replay(dir, plan.pairs, ALL)];
  const last = emissions.at(-1);
  // Every component present on every emission; earlier pairs rest at their marks.
  expect(last?.cursor.map((component) => component.project)).toEqual(["alpha", "beta", "beta"]);
  expect(watermarkFor(marks, "beta").map((component) => component.source)).toEqual([
    "telemetry",
    "log",
  ]);
});
