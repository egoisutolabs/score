import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkIdentity } from "@score/core/dispatch/dispatch.identity";
import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import type { TelemetryEvent, TelemetryRecord } from "@score/core/telemetry/telemetry.interface";
import { GAP_RECORD_NAME } from "@score/core/telemetry/telemetry.interface";
import { TelemetryLogService } from "@score/core/telemetry/telemetry-log.service";
import { afterEach, expect, test } from "vitest";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "score-telemetry-"));
  sandboxes.push(path);
  return path;
}

const resource = { project: "demo" };

function clock(iso: string): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(iso);
  return { now: () => current, set: (next) => (current = new Date(next)) };
}

function event(name: string, time: string, extra?: Partial<TelemetryEvent>): TelemetryEvent {
  return { version: 1, time, name, kind: "event", resource, ...extra };
}

test("a reader tails complete lines while a writer appends — every record once", async () => {
  const dir = await sandbox();
  const time = clock("2026-08-15T12:00:00Z");
  const log = new TelemetryLogService(dir, resource, time.now);

  log.append(event("score.dispatch.started", "2026-08-15T12:00:00.000Z"));
  let result = log.read(log.startCursor());
  expect(result.outcome).toBe("ok");
  expect(result.records.map((record) => record.name)).toEqual(["score.dispatch.started"]);

  log.append(event("score.dispatch.blocked", "2026-08-15T12:00:01.000Z"));
  log.append(event("score.landing.merged", "2026-08-15T12:00:02.000Z"));
  result = log.read(result.cursor);
  expect(result.records.map((record) => record.name)).toEqual([
    "score.dispatch.blocked",
    "score.landing.merged",
  ]);

  // Fully caught up: nothing new, cursor stable.
  const idle = log.read(result.cursor);
  expect(idle.records).toEqual([]);
  expect(idle.cursor).toEqual(result.cursor);

  // Filters bound the scan but still advance the cursor over skipped lines.
  const filtered = log.read(log.startCursor(), { names: ["score.dispatch"] });
  expect(filtered.records.map((record) => record.name)).toEqual([
    "score.dispatch.started",
    "score.dispatch.blocked",
  ]);
  expect(filtered.cursor).toEqual(result.cursor);
});

test("a trailing partial line is withheld until complete — no skipped or doubled bytes", async () => {
  const dir = await sandbox();
  const time = clock("2026-08-15T12:00:00Z");
  const log = new TelemetryLogService(dir, resource, time.now);
  log.append(event("score.dispatch.started", "2026-08-15T12:00:00.000Z"));

  const segment = join(dir, "2026-08-15.jsonl");
  const line = `${JSON.stringify(event("score.landing.merged", "2026-08-15T12:00:01.000Z"))}\n`;
  const torn = Math.floor(line.length / 2);
  appendFileSync(segment, line.slice(0, torn));

  const first = log.read(log.startCursor());
  expect(first.records.map((record) => record.name)).toEqual(["score.dispatch.started"]);
  expect(first.warnings).toEqual([]);

  // Withheld, not consumed: the cursor sits exactly at the fragment's start.
  const stalled = log.read(first.cursor);
  expect(stalled.records).toEqual([]);
  expect(stalled.cursor).toEqual(first.cursor);

  appendFileSync(segment, line.slice(torn));
  const completed = log.read(first.cursor);
  expect(completed.records.map((record) => record.name)).toEqual(["score.landing.merged"]);
  expect(completed.warnings).toEqual([]);
});

test("restart after a torn write terminates the fragment and emits a gap record", async () => {
  const dir = await sandbox();
  const time = clock("2026-08-15T12:00:00Z");
  const writer = new TelemetryLogService(dir, resource, time.now);
  writer.append(event("score.dispatch.started", "2026-08-15T12:00:00.000Z"));
  appendFileSync(join(dir, "2026-08-15.jsonl"), '{"version":1,"name":"score.torn');

  // The process died mid-append; a fresh writer recovers before its first record.
  const restarted = new TelemetryLogService(dir, resource, time.now);
  restarted.append(event("score.repair.pinged", "2026-08-15T12:00:05.000Z"));

  const result = restarted.read(restarted.startCursor());
  expect(result.records.map((record) => record.name)).toEqual([
    "score.dispatch.started",
    GAP_RECORD_NAME,
    "score.repair.pinged",
  ]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("unparseable");
});

test("UTC rotation neither loses nor duplicates the boundary record", async () => {
  const dir = await sandbox();
  const time = clock("2026-08-15T23:59:59.500Z");
  const log = new TelemetryLogService(dir, resource, time.now);
  log.append(event("score.dispatch.started", "2026-08-15T23:59:59.500Z"));
  const caughtUp = log.read(log.startCursor());
  expect(caughtUp.records).toHaveLength(1);

  time.set("2026-08-16T00:00:00.250Z");
  log.append(event("score.landing.merged", "2026-08-16T00:00:00.250Z"));
  expect(existsSync(join(dir, "2026-08-15.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "2026-08-16.jsonl"))).toBe(true);

  // The tailing reader crosses the boundary and sees the new record exactly once.
  const next = log.read(caughtUp.cursor);
  expect(next.records.map((record) => record.name)).toEqual(["score.landing.merged"]);
  expect(next.cursor.segment).toBe("2026-08-16");
  expect(log.read(next.cursor).records).toEqual([]);

  // A from-scratch scan sees both records exactly once.
  const full = log.read(log.startCursor());
  expect(full.records.map((record) => record.name)).toEqual([
    "score.dispatch.started",
    "score.landing.merged",
  ]);
});

test("a segment deleted between read()'s snapshot and its open expires the cursor", async () => {
  const dir = await sandbox();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-07-16.jsonl"),
    `${JSON.stringify(event("score.dispatch.started", "2026-07-16T12:00:00.000Z"))}\n`,
  );
  writeFileSync(
    join(dir, "2026-07-20.jsonl"),
    `${JSON.stringify(event("score.landing.merged", "2026-07-20T12:00:00.000Z"))}\n`,
  );
  const log = new TelemetryLogService(dir, resource, clock("2026-08-15T12:00:00Z").now);
  const cursor = log.startCursor();
  expect(cursor.segment).toBe("2026-07-16");

  // Simulate a retention sweep landing inside read()'s race window: the
  // snapshot still lists the segment while its file is already gone.
  (log as unknown as { listSegments: () => string[] }).listSegments = () => [
    "2026-07-16",
    "2026-07-20",
  ];
  unlinkSync(join(dir, "2026-07-16.jsonl"));

  const result = log.read(cursor);
  expect(result.outcome).toBe("cursor-expired");
  expect(result.records).toEqual([]);
  expect(result.cursor).toEqual(cursor);
});

test("a never-written day is skipped; consumed bytes in a vanished segment expire", async () => {
  const dir = await sandbox();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-07-16.jsonl"),
    `${JSON.stringify(event("score.dispatch.started", "2026-07-16T12:00:00.000Z"))}\n`,
  );
  writeFileSync(
    join(dir, "2026-07-20.jsonl"),
    `${JSON.stringify(event("score.landing.merged", "2026-07-20T12:00:00.000Z"))}\n`,
  );
  const log = new TelemetryLogService(dir, resource, clock("2026-08-15T12:00:00Z").now);

  // A cursor on a gap day (no file ever existed) just advances — not expired.
  const gapDay = {
    project: "demo",
    source: "telemetry" as const,
    segment: "2026-07-18",
    byte_offset: 0,
  };
  const advanced = log.read(gapDay);
  expect(advanced.outcome).toBe("ok");
  expect(advanced.records.map((record) => record.name)).toEqual(["score.landing.merged"]);

  // The same missing date with consumed bytes proves the segment existed and was deleted.
  const midSegment = { ...gapDay, byte_offset: 10 };
  expect(log.read(midSegment).outcome).toBe("cursor-expired");
});

test("a transient failure during recovery leaves it pending — the next append retries", async () => {
  const dir = await sandbox();
  const time = clock("2026-08-15T12:00:00Z");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-08-15.jsonl"), '{"version":1,"name":"score.torn');

  const log = new TelemetryLogService(dir, resource, time.now);
  const patched = log as unknown as { recoverTornWrite: () => void };
  const original = patched.recoverTornWrite.bind(log);
  let calls = 0;
  patched.recoverTornWrite = () => {
    calls += 1;
    if (calls === 1) throw new Error("disk hiccup");
    original();
  };

  log.append(event("score.dispatch.started", "2026-08-15T12:00:00.000Z"));
  expect(log.appendFailures).toBe(1); // failed append counted, recovery still pending

  log.append(event("score.repair.pinged", "2026-08-15T12:00:05.000Z"));
  const result = log.read(log.startCursor());
  // The retried recovery terminated the fragment before the record landed —
  // nothing concatenated onto the torn tail.
  expect(result.records.map((record) => record.name)).toEqual([
    GAP_RECORD_NAME,
    "score.repair.pinged",
  ]);
  expect(result.warnings).toHaveLength(1);
});

test("a v1 reader yields every v1 record over unknown fields and versions — one warning, no crash", async () => {
  const dir = await sandbox();
  mkdirSync(dir, { recursive: true });
  const v1WithUnknownField = {
    ...event("score.dispatch.started", "2026-08-15T12:00:00.000Z"),
    future_field: "kept",
  };
  const unknownVersion = { ...event("score.future.thing", "2026-08-15T12:00:01.000Z"), version: 2 };
  const v1Plain = event("score.landing.merged", "2026-08-15T12:00:02.000Z");
  writeFileSync(
    join(dir, "2026-08-15.jsonl"),
    `${[v1WithUnknownField, unknownVersion, v1Plain].map((r) => `${JSON.stringify(r)}\n`).join("")}null\n`,
  );

  const log = new TelemetryLogService(dir, resource, clock("2026-08-15T13:00:00Z").now);
  const result = log.read(log.startCursor());
  expect(result.records.map((record) => record.name)).toEqual([
    "score.dispatch.started",
    "score.landing.merged",
  ]);
  expect((result.records[0] as TelemetryRecord & { future_field?: string }).future_field).toBe(
    "kept",
  );
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings[0]).toContain("unknown record version 2");
  // Valid JSON that is not an object (`null`) warns instead of crashing the reader.
  expect(result.warnings[1]).toContain("non-record");
});

test("subject identity round-trips byte-identical from dispatch.identity values", async () => {
  const dir = await sandbox();
  const issue: IssueObservation = {
    number: 53,
    title: "Telemetry contract and append-only JSONL",
    body: "",
    labels: [],
    state: "OPEN",
    url: "https://github.com/egoisutolabs/score/issues/53",
    comments: [],
  };
  const identity = createWorkIdentity("/workspace", issue, "demo");
  const log = new TelemetryLogService(dir, resource, clock("2026-08-15T12:00:00Z").now);
  log.append(
    event("score.dispatch.started", "2026-08-15T12:00:00.000Z", {
      subject: {
        session: identity.sessionName,
        branch: identity.branch,
        issue_number: identity.issueNumber,
      },
    }),
  );
  expect(log.appendFailures).toBe(0);

  const [record] = log.read(log.startCursor()).records;
  expect(record?.subject?.session).toBe(identity.sessionName);
  expect(record?.subject?.branch).toBe(identity.branch);
  expect(record?.subject?.issue_number).toBe(identity.issueNumber);
});

test("retention deletes whole strictly-older segments and expires their cursors", async () => {
  const dir = await sandbox();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-07-10.jsonl"),
    `${JSON.stringify(event("score.dispatch.started", "2026-07-10T12:00:00.000Z"))}\n`,
  );
  writeFileSync(
    join(dir, "2026-07-16.jsonl"),
    `${JSON.stringify(event("score.dispatch.started", "2026-07-16T12:00:00.000Z"))}\n`,
  );
  const log = new TelemetryLogService(dir, resource, clock("2026-08-15T12:00:00Z").now);
  const expiredCursor = log.startCursor(); // names 2026-07-10
  expect(expiredCursor.segment).toBe("2026-07-10");

  log.sweepRetention(30);
  // Exactly 30 days old survives; strictly older is gone — same rule as the prose log.
  expect(existsSync(join(dir, "2026-07-10.jsonl"))).toBe(false);
  expect(existsSync(join(dir, "2026-07-16.jsonl"))).toBe(true);

  const result = log.read(expiredCursor);
  expect(result.outcome).toBe("cursor-expired");
  expect(result.records).toEqual([]);
  expect(result.cursor).toEqual(expiredCursor);
});

test("a sweep over an unreadable directory throws — never reports success over nothing", async () => {
  // A directory-shaped path occupied by a file enumerates as ENOTDIR, the
  // same non-absence failure class as EACCES but testable without chmod.
  const parent = await sandbox();
  const blocked = join(parent, "telemetry");
  writeFileSync(blocked, "not a directory\n");
  const log = new TelemetryLogService(blocked, resource, clock("2026-08-15T12:00:00Z").now);
  expect(() => log.sweepRetention(30)).toThrow();

  // A missing directory genuinely has no stale segments: absence is not a failure.
  const missing = new TelemetryLogService(
    join(parent, "absent"),
    resource,
    clock("2026-08-15T12:00:00Z").now,
  );
  expect(() => missing.sweepRetention(30)).not.toThrow();
});

test("rejected appends never write, count failures, and rate-limit error reports", async () => {
  const dir = await sandbox();
  const time = clock("2026-08-15T12:00:00Z");
  const errors: string[] = [];
  const log = new TelemetryLogService(dir, resource, time.now, (message) => errors.push(message));

  const bad = event("not a telemetry name", "2026-08-15T12:00:00.000Z");
  log.append(bad);
  log.append({ ...bad, attributes: { prompt: "secret" } });
  expect(log.appendFailures).toBe(2);
  expect(errors).toHaveLength(1); // second failure inside the report interval stays quiet

  time.set("2026-08-15T12:01:01Z");
  log.append(bad);
  expect(log.appendFailures).toBe(3);
  expect(errors).toHaveLength(2);

  // A record for another project is rejected, never written into this project's segments.
  log.append(
    event("score.dispatch.started", "2026-08-15T12:01:01.000Z", {
      resource: { project: "other" },
    }),
  );
  expect(log.appendFailures).toBe(4);

  expect(existsSync(join(dir, "2026-08-15.jsonl"))).toBe(false);
});

test("a throwing onError reporter never escapes into the caller", async () => {
  const dir = await sandbox();
  const log = new TelemetryLogService(dir, resource, clock("2026-08-15T12:00:00Z").now, () => {
    throw new Error("reporter writes to the same dead disk");
  });
  const bad = event("not a telemetry name", "2026-08-15T12:00:00.000Z");
  expect(() => log.append(bad)).not.toThrow();
  expect(log.appendFailures).toBe(1);
});
