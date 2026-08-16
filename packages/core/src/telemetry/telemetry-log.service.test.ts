import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clock,
  event,
  line,
  project,
  seedSegment,
} from "@score/core/telemetry/fixtures/telemetry-log.fixture";
import type { TelemetryCursor } from "@score/core/telemetry/telemetry.interface";
import { MAX_BODY_BYTES } from "@score/core/telemetry/telemetry.policy";
import { GAP_RECORD_NAME, TelemetryLogService } from "@score/core/telemetry/telemetry-log.service";
import { afterEach, expect, test } from "vitest";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "score-telemetry-log-"));
  sandboxes.push(path);
  return path;
}

test("interleaved writer/reader: complete lines during appends — no duplicate, skipped, or partial bytes", () => {
  const dir = sandbox();
  const time = clock("2026-08-15T12:00:00Z");
  const log = new TelemetryLogService(dir, { project }, time.now);

  expect(log.append(event({ name: "score.run.one" }))).toBe("APPENDED");
  const first = log.read(log.startCursor());
  expect(first.outcome).toBe("OK");
  expect(first.records.map((r) => r.name)).toEqual(["score.run.one"]);

  expect(log.append(event({ name: "score.run.two" }))).toBe("APPENDED");
  expect(log.append(event({ name: "score.run.three" }))).toBe("APPENDED");
  const second = log.read(first.cursor);
  expect(second.records.map((r) => r.name)).toEqual(["score.run.two", "score.run.three"]);
  expect(second.warnings).toEqual([]);

  // A torn append in flight: the incomplete tail is withheld entirely, and
  // the cursor never advances past it.
  seedSegment(
    dir,
    "2026-08-15",
    readFileSync(join(dir, "2026-08-15.jsonl"), "utf8") + '{"v":1,"na',
  );
  const withheld = log.read(second.cursor);
  expect(withheld.records).toEqual([]);
  expect(withheld.warnings).toEqual([]);
  expect(withheld.cursor).toEqual(second.cursor);

  // Once the line completes, its bytes resolve exactly once.
  seedSegment(
    dir,
    "2026-08-15",
    readFileSync(join(dir, "2026-08-15.jsonl"), "utf8") +
      'me":"score.run.four","ts":"2026-08-15T12:00:01Z","signal":"event","project":"demo"}\n',
  );
  const completed = log.read(withheld.cursor);
  expect(completed.records.map((r) => r.name)).toEqual(["score.run.four"]);
  expect(log.read(completed.cursor).records).toEqual([]);
});

test("torn-write restart terminates the fragment; reader sees a gap record next", () => {
  const dir = sandbox();
  seedSegment(dir, "2026-08-14", line(event({ name: "score.run.before" })) + '{"v":1,"torn');

  const time = clock("2026-08-15T08:00:00Z");
  const restarted = new TelemetryLogService(dir, { project }, time.now);
  expect(restarted.append(event({ name: "score.run.after" }))).toBe("APPENDED");

  const result = restarted.read(restarted.startCursor());
  expect(result.outcome).toBe("OK");
  expect(result.records.map((r) => r.name)).toEqual([
    "score.run.before",
    GAP_RECORD_NAME,
    "score.run.after",
  ]);
  const gap = result.records[1];
  expect(gap?.attributes).toEqual({ segment: "2026-08-14" });
  // The terminated fragment itself is the one warning — never parsed or salvaged.
  expect(result.warnings).toEqual(["unparseable line in 2026-08-14.jsonl"]);
});

test("UTC rotation: the boundary record lands exactly once, in the correct segment", () => {
  const dir = sandbox();
  const time = clock("2026-08-15T23:59:59Z");
  const log = new TelemetryLogService(dir, { project }, time.now);

  expect(log.append(event({ name: "score.run.late" }))).toBe("APPENDED");
  time.set("2026-08-16T00:00:00Z");
  expect(log.append(event({ name: "score.run.early" }))).toBe("APPENDED");

  expect(readFileSync(join(dir, "2026-08-15.jsonl"), "utf8")).toBe(
    line(event({ name: "score.run.late" })),
  );
  expect(readFileSync(join(dir, "2026-08-16.jsonl"), "utf8")).toBe(
    line(event({ name: "score.run.early" })),
  );

  // The reader crosses the segment boundary in order, without duplication.
  const result = log.read(log.startCursor());
  expect(result.records.map((r) => r.name)).toEqual(["score.run.late", "score.run.early"]);
  expect(result.cursor.segment).toBe("2026-08-16");
});

test("reader tolerance: unknown fields ride along, unknown v and unparseable lines each cost one warning", () => {
  const dir = sandbox();
  seedSegment(
    dir,
    "2026-08-15",
    line({ ...event({ name: "score.run.one" }), future_field: "ignored" }) +
      line({ ...event(), v: 2, name: "score.run.v2" }) +
      "not json at all\n" +
      line(event({ name: "score.run.two" })),
  );

  const log = new TelemetryLogService(dir, { project });
  const result = log.read(log.startCursor());
  expect(result.outcome).toBe("OK");
  expect(result.records.map((r) => r.name)).toEqual(["score.run.one", "score.run.two"]);
  expect((result.records[0] as { future_field?: string }).future_field).toBe("ignored");
  expect(result.warnings).toEqual([
    "unknown record version 2 in 2026-08-15.jsonl",
    "unparseable line in 2026-08-15.jsonl",
  ]);
});

test("retention deletes strictly-older segments; exactly-N-days-old survives", () => {
  const dir = sandbox();
  seedSegment(dir, "2026-07-15", line(event()));
  seedSegment(dir, "2026-07-16", line(event()));
  seedSegment(dir, "2026-08-15", line(event()));

  const time = clock("2026-08-15T12:00:00Z");
  const log = new TelemetryLogService(dir, { project }, time.now);
  log.sweepRetention(30);

  expect(existsSync(join(dir, "2026-07-15.jsonl"))).toBe(false);
  expect(existsSync(join(dir, "2026-07-16.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "2026-08-15.jsonl"))).toBe(true);
});

test("a cursor into a deleted segment expires instead of silently skipping", () => {
  const dir = sandbox();
  seedSegment(dir, "2026-07-15", line(event()));
  seedSegment(dir, "2026-08-15", line(event()));

  const time = clock("2026-08-15T12:00:00Z");
  const log = new TelemetryLogService(dir, { project }, time.now);
  const expired: TelemetryCursor = {
    project,
    source: "telemetry",
    segment: "2026-07-15",
    byte_offset: 0,
  };
  log.sweepRetention(30);

  const result = log.read(expired);
  expect(result.outcome).toBe("CURSOR_EXPIRED");
  expect(result.records).toEqual([]);
  expect(result.cursor).toEqual(expired);
});

test("a listed segment that cannot be opened expires the cursor instead of silently skipping", () => {
  const dir = sandbox();
  seedSegment(dir, "2026-08-14", line(event()));
  seedSegment(dir, "2026-08-15", line(event()));
  chmodSync(join(dir, "2026-08-14.jsonl"), 0o000);

  const log = new TelemetryLogService(dir, { project }, clock("2026-08-15T12:00:00Z").now);
  const result = log.read(log.startCursor());
  expect(result.outcome).toBe("CURSOR_EXPIRED");
  expect(result.records).toEqual([]);
});

test("offsets beyond file length or mid-line yield data from the next complete line", () => {
  const dir = sandbox();
  const first = line(event({ name: "score.run.one" }));
  seedSegment(dir, "2026-08-15", first + line(event({ name: "score.run.two" })));

  const log = new TelemetryLogService(dir, { project }, clock("2026-08-15T12:00:00Z").now);
  const midLine = log.read({ project, source: "telemetry", segment: "2026-08-15", byte_offset: 3 });
  expect(midLine.outcome).toBe("OK");
  expect(midLine.records.map((r) => r.name)).toEqual(["score.run.two"]);
  expect(midLine.warnings).toEqual([]);

  const beyond = log.read({
    project,
    source: "telemetry",
    segment: "2026-08-15",
    byte_offset: 10_000,
  });
  expect(beyond.outcome).toBe("OK");
  expect(beyond.records).toEqual([]);
  seedSegment(
    dir,
    "2026-08-15",
    first + line(event({ name: "score.run.two" })) + line(event({ name: "score.run.three" })),
  );
  expect(log.read(beyond.cursor).records.map((r) => r.name)).toEqual(["score.run.three"]);
});

test("an unwritable segment fails the append — no throw, no retry, no partial bytes", () => {
  const dir = sandbox();
  seedSegment(dir, "2026-08-15", line(event({ name: "score.run.existing" })));
  chmodSync(join(dir, "2026-08-15.jsonl"), 0o444);

  const time = clock("2026-08-15T12:00:00Z");
  const log = new TelemetryLogService(dir, { project }, time.now);
  expect(log.append(event({ name: "score.run.lost" }))).toBe("FAILED");
  expect(log.append(event({ name: "score.run.lost" }))).toBe("FAILED");
  expect(readFileSync(join(dir, "2026-08-15.jsonl"), "utf8")).toBe(
    line(event({ name: "score.run.existing" })),
  );
});

test("a rejected record fails the append even into a writable segment", () => {
  const dir = sandbox();
  const log = new TelemetryLogService(dir, { project }, clock("2026-08-15T12:00:00Z").now);

  expect(log.append(event({ name: "not-score-namespaced" }))).toBe("FAILED");
  // A record for another project never lands in this project's segments.
  expect(log.append(event({ project: "someone-else" }))).toBe("FAILED");
  expect(existsSync(join(dir, "2026-08-15.jsonl"))).toBe(false);
});

test("an oversized body is stored bounded and marked truncated — gate first, truncate second", () => {
  const dir = sandbox();
  const log = new TelemetryLogService(dir, { project }, clock("2026-08-15T12:00:00Z").now);

  expect(log.append(event({ body: "x".repeat(MAX_BODY_BYTES + 1) }))).toBe("APPENDED");
  const stored = log.read(log.startCursor()).records[0] as { body?: string; truncated?: boolean };
  expect(stored.truncated).toBe(true);
  expect(new TextEncoder().encode(stored.body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
});
