/**
 * The #82 acceptance suite, driven end to end through StreamService with
 * follow=true: live transcripts, the resume matrix, rotation order, shared
 * tailer instance counting, the queue ceiling, heartbeats, and mid-stream
 * deletion. Timers are faked; file events are driven by the tailer's stat
 * poll, never by fs.watch latency.
 */

import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { decodeCursor } from "./cursor.render";
import {
  cleanupSandboxes,
  drain,
  logLine,
  newProjectsDir,
  type ParsedFrame,
  parseFrames,
  seed,
  seedRecords,
  TODAY,
  testDeps,
} from "./fixtures/stream.fixture";
import { FOLLOW_QUEUE_LIMIT, HEARTBEAT_FRAME, HEARTBEAT_INTERVAL_MS } from "./follow.service";
import type { StreamDeps } from "./stream.service";
import { StreamService } from "./stream.service";
import { TAILER_POLL_INTERVAL_MS, TailerRegistry } from "./tailer.service";

const TOMORROW = "2026-08-16";

afterEach(() => {
  vi.useRealTimers();
  cleanupSandboxes();
});

/** Only timers are faked: Date stays real (the clock is injected), fs stays real. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
}

function probe(n: number, project = "score"): object {
  return {
    v: 1,
    ts: `${TODAY}T12:00:00.000Z`,
    project,
    signal: "event",
    name: "score.follow.probe",
    attributes: { n },
  };
}

function appendProbes(dir: string, project: string, segment: string, ns: readonly number[]): void {
  appendFileSync(
    join(dir, project, "telemetry", `${segment}.jsonl`),
    ns.map((n) => `${JSON.stringify(probe(n, project))}\n`).join(""),
  );
}

async function subscribe(
  deps: StreamDeps,
  search: string,
  lastEventId: string | null = null,
): Promise<AsyncGenerator<string>> {
  const outcome = await new StreamService(deps).open(new URLSearchParams(search), lastEventId);
  if (outcome.kind !== "stream") throw new Error(`expected a stream, got ${outcome.reason}`);
  return outcome.frames();
}

/** A whole follow=false stream, for the resume legs of the matrix. */
async function collect(
  deps: StreamDeps,
  search: string,
  lastEventId: string | null = null,
): Promise<readonly ParsedFrame[]> {
  const outcome = await new StreamService(deps).open(new URLSearchParams(search), lastEventId);
  if (outcome.kind !== "stream") throw new Error(`expected a stream, got ${outcome.reason}`);
  return await drain(outcome.frames);
}

async function pullUntil(
  gen: AsyncGenerator<string>,
  event: string,
): Promise<readonly ParsedFrame[]> {
  const seen: ParsedFrame[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) throw new Error(`stream closed before ${event}`);
    const frame = parseFrames(next.value)[0];
    if (frame === undefined) throw new Error("empty frame");
    seen.push(frame);
    if (frame.event === event) return seen;
  }
}

async function pullFrame(gen: AsyncGenerator<string>): Promise<ParsedFrame> {
  const next = await gen.next();
  if (next.done) throw new Error("stream closed early");
  const frame = parseFrames(next.value)[0];
  if (frame === undefined) throw new Error("empty frame");
  return frame;
}

function probeNs(frames: readonly ParsedFrame[]): readonly number[] {
  return frames
    .filter((frame) => frame.event === "score.telemetry.event")
    .map((frame) => (frame.envelope.data as { attributes: { n: number } }).attributes.n);
}

function offsetOf(cursor: string | undefined, source: string, project = "score"): number {
  const component = decodeCursor(cursor ?? "")?.find(
    (candidate) => candidate.source === source && candidate.project === project,
  );
  if (component === undefined) throw new Error(`no ${project}/${source} component`);
  return component.byte_offset;
}

test("live follow: appends after caught_up arrive with advancing, per-source-independent cursors", async () => {
  fakeTimers();
  const dir = newProjectsDir();
  seedRecords(dir, "score", TODAY, [probe(0)]);
  seed(dir, "score", `logs/${TODAY}.log`, logLine(`${TODAY}T11:00:00.000Z`, "info", "before"));
  const deps = testDeps(dir);
  const gen = await subscribe(deps, "projects=score&signals=event,log");
  const upfront = await pullUntil(gen, "score.stream.caught_up");
  const caughtUp = upfront.at(-1)?.envelope.cursor;

  // These appends land between caught_up and the first follow pull: the
  // initial scan covers the attach gap, no poll tick required.
  appendProbes(dir, "score", TODAY, [1]);
  appendFileSync(
    join(dir, "score", "logs", `${TODAY}.log`),
    logLine(`${TODAY}T12:00:01.000Z`, "info", "after"),
  );
  const first = await pullFrame(gen);
  const second = await pullFrame(gen);
  expect(first.event).toBe("score.telemetry.event");
  expect(probeNs([first])).toEqual([1]);
  expect(second.event).toBe("score.log.record");
  expect((second.envelope.data as { body: string }).body).toBe("after");

  // The first frame advanced only the telemetry component; the log
  // component still rests at its caught_up mark — sources are independent.
  expect(offsetOf(first.envelope.cursor, "telemetry")).toBeGreaterThan(
    offsetOf(caughtUp, "telemetry"),
  );
  expect(offsetOf(first.envelope.cursor, "log")).toBe(offsetOf(caughtUp, "log"));
  expect(offsetOf(second.envelope.cursor, "log")).toBeGreaterThan(offsetOf(caughtUp, "log"));

  // A later append arrives through the shared tailer's stat poll.
  const pending = gen.next();
  appendProbes(dir, "score", TODAY, [2]);
  await vi.advanceTimersByTimeAsync(TAILER_POLL_INTERVAL_MS);
  const third = parseFrames((await pending).value as string)[0];
  expect(third?.event).toBe("score.telemetry.event");
  expect(probeNs([third as ParsedFrame])).toEqual([2]);
  await gen.return(undefined);

  // Mid-follow resume: the first follow frame's cursor reconnects at
  // exactly the records after it — the log line and probe 2, nothing twice.
  const resumed = await collect(
    deps,
    "projects=score&signals=event,log&follow=false",
    first.envelope.cursor ?? null,
  );
  expect(probeNs(resumed)).toEqual([2]);
  expect(
    resumed
      .filter((frame) => frame.event === "score.log.record")
      .map((frame) => (frame.envelope.data as { body: string }).body),
  ).toEqual(["after"]);
});

test("resume matrix: reconnecting at every replay boundary yields the rest exactly", async () => {
  const dir = newProjectsDir();
  seedRecords(
    dir,
    "score",
    TODAY,
    [0, 1, 2, 3, 4].map((n) => probe(n)),
  );
  const deps = testDeps(dir);
  const full = await collect(deps, "projects=score&signals=event&follow=false");
  const records = full.filter((frame) => frame.event === "score.telemetry.event");
  expect(probeNs(records)).toEqual([0, 1, 2, 3, 4]);

  // Mid-batch: every record's cursor resumes at its successor.
  for (const [i, frame] of records.entries()) {
    const resumed = await collect(
      deps,
      "projects=score&signals=event&follow=false",
      frame.envelope.cursor,
    );
    expect(probeNs(resumed)).toEqual([1, 2, 3, 4].slice(i));
  }

  // At caught_up: nothing replays again.
  const boundary = full.at(-1);
  expect(boundary?.event).toBe("score.stream.caught_up");
  const resumed = await collect(
    deps,
    "projects=score&signals=event&follow=false",
    boundary?.envelope.cursor ?? null,
  );
  expect(probeNs(resumed)).toEqual([]);
});

test("multi-project follow: a quiet project's records are never skipped by a busy one's progress", async () => {
  fakeTimers();
  const dir = newProjectsDir();
  seedRecords(dir, "score", TODAY, [probe(0)]);
  seedRecords(dir, "beta", TODAY, [probe(100, "beta")]);
  const deps = testDeps(dir);
  const gen = await subscribe(deps, "projects=score,beta&signals=event");
  const upfront = await pullUntil(gen, "score.stream.caught_up");
  const caughtUp = upfront.at(-1)?.envelope.cursor;
  // Membership is sorted, so beta replays before score.
  expect(probeNs(upfront)).toEqual([100, 0]);

  // Only score writes; beta's component must not move with it.
  const pending = gen.next();
  appendProbes(dir, "score", TODAY, [1]);
  await vi.advanceTimersByTimeAsync(TAILER_POLL_INTERVAL_MS);
  const busy = parseFrames((await pending).value as string)[0] as ParsedFrame;
  expect(probeNs([busy])).toEqual([1]);
  expect(offsetOf(busy.envelope.cursor, "telemetry", "beta")).toBe(
    offsetOf(caughtUp, "telemetry", "beta"),
  );
  await gen.return(undefined);

  // Beta finally writes; resuming from the busy frame's cursor yields the
  // quiet project's new record and re-delivers nothing.
  appendProbes(dir, "beta", TODAY, [101]);
  const resumed = await collect(
    deps,
    "projects=score,beta&signals=event&follow=false",
    busy.envelope.cursor,
  );
  expect(probeNs(resumed)).toEqual([101]);
});

test("rotation follow: the old segment finishes before the new one begins, order preserved", async () => {
  fakeTimers();
  const dir = newProjectsDir();
  seedRecords(dir, "score", TODAY, [probe(0)]);
  const deps = testDeps(dir);
  const gen = await subscribe(deps, "projects=score&signals=event");
  await pullUntil(gen, "score.stream.caught_up");

  // The UTC roll: the writer finishes today's segment, then opens tomorrow's.
  const pending = gen.next();
  appendProbes(dir, "score", TODAY, [1]);
  seedRecords(dir, "score", TOMORROW, [probe(2), probe(3)]);
  await vi.advanceTimersByTimeAsync(TAILER_POLL_INTERVAL_MS);
  const first = parseFrames((await pending).value as string)[0] as ParsedFrame;
  const second = await pullFrame(gen);
  const third = await pullFrame(gen);
  expect(probeNs([first, second, third])).toEqual([1, 2, 3]);
  expect(decodeCursor(first.envelope.cursor)?.[0]?.segment).toBe(TODAY);
  expect(decodeCursor(second.envelope.cursor)?.[0]?.segment).toBe(TOMORROW);
  expect(decodeCursor(third.envelope.cursor)?.[0]?.segment).toBe(TOMORROW);
  await gen.return(undefined);
});

test("two clients share one tailer; the last release stops it", async () => {
  fakeTimers();
  const dir = newProjectsDir();
  seedRecords(dir, "score", TODAY, [probe(0)]);
  const tailers = new TailerRegistry();
  const genA = await subscribe(testDeps(dir, { tailers }), "projects=score&signals=event");
  const genB = await subscribe(testDeps(dir, { tailers }), "projects=score&signals=event");
  await pullUntil(genA, "score.stream.caught_up");
  await pullUntil(genB, "score.stream.caught_up");

  const pendingA = genA.next();
  const pendingB = genB.next();
  appendProbes(dir, "score", TODAY, [1]);
  await vi.advanceTimersByTimeAsync(TAILER_POLL_INTERVAL_MS);
  // One shared loop fed both subscriptions the same append.
  expect(tailers.size()).toBe(1);
  for (const pending of [pendingA, pendingB]) {
    const frame = parseFrames((await pending).value as string)[0] as ParsedFrame;
    expect(probeNs([frame])).toEqual([1]);
  }

  await genA.return(undefined);
  expect(tailers.size()).toBe(1);
  await genB.return(undefined);
  expect(tailers.size()).toBe(0);
});

test("the 1025th queued envelope disconnects; the last written cursor resumes exactly", async () => {
  fakeTimers();
  const dir = newProjectsDir();
  seedRecords(dir, "score", TODAY, [probe(0)]);
  const deps = testDeps(dir);
  const gen = await subscribe(deps, "projects=score&signals=event");
  const upfront = await pullUntil(gen, "score.stream.caught_up");
  const caughtUp = upfront.at(-1)?.envelope.cursor ?? null;

  // The consumer never pulls again while the writer floods one envelope
  // past the ceiling: the subscription is disconnected, not stalled.
  expect(FOLLOW_QUEUE_LIMIT).toBe(1024);
  const pending = gen.next();
  appendProbes(
    dir,
    "score",
    TODAY,
    Array.from({ length: FOLLOW_QUEUE_LIMIT + 1 }, (_, i) => i + 1),
  );
  await vi.advanceTimersByTimeAsync(TAILER_POLL_INTERVAL_MS);
  expect((await pending).done).toBe(true);

  // The client's last written cursor (caught_up) resumes with every flooded
  // record — no gap, no duplicate.
  const resumed = await collect(deps, "projects=score&signals=event&follow=false", caughtUp);
  expect(probeNs(resumed)).toEqual(Array.from({ length: FOLLOW_QUEUE_LIMIT + 1 }, (_, i) => i + 1));

  // Exactly at the ceiling nothing disconnects: the stream keeps serving.
  const gen2 = await subscribe(deps, "projects=score&signals=event");
  await pullUntil(gen2, "score.stream.caught_up");
  const pending2 = gen2.next();
  appendProbes(
    dir,
    "score",
    TODAY,
    Array.from({ length: FOLLOW_QUEUE_LIMIT }, (_, i) => i + 2000),
  );
  await vi.advanceTimersByTimeAsync(TAILER_POLL_INTERVAL_MS);
  const frame = parseFrames((await pending2).value as string)[0] as ParsedFrame;
  expect(probeNs([frame])).toEqual([2000]);
  await gen2.return(undefined);
});

test("idle stream: a heartbeat comment rides every 15s window", async () => {
  fakeTimers();
  const dir = newProjectsDir();
  seedRecords(dir, "score", TODAY, [probe(0)]);
  const gen = await subscribe(testDeps(dir), "projects=score&signals=event");
  await pullUntil(gen, "score.stream.caught_up");

  const first = gen.next();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
  expect((await first).value).toBe(HEARTBEAT_FRAME);
  const second = gen.next();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
  expect((await second).value).toBe(HEARTBEAT_FRAME);
  expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
  await gen.return(undefined);
});

test("mid-stream segment deletion: one warning, then a clean close", async () => {
  fakeTimers();
  const dir = newProjectsDir();
  seedRecords(dir, "score", TODAY, [probe(0)]);
  const gen = await subscribe(testDeps(dir), "projects=score&signals=event");
  await pullUntil(gen, "score.stream.caught_up");

  const pending = gen.next();
  // Let the subscription attach (and the tailer capture its baseline)
  // before retention removes the segment the cursor still names.
  await vi.advanceTimersByTimeAsync(1);
  rmSync(join(dir, "score", "telemetry", `${TODAY}.jsonl`));
  await vi.advanceTimersByTimeAsync(TAILER_POLL_INTERVAL_MS);
  const warning = parseFrames((await pending).value as string)[0];
  expect(warning?.event).toBe("score.stream.warning");
  expect(warning?.envelope.warnings).toEqual([{ reason: "SEGMENT_UNREADABLE" }]);
  expect((await gen.next()).done).toBe(true);
});
