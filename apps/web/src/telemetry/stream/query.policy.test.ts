import type { TelemetryRecord } from "@score/core/telemetry/telemetry.interface";
import { describe, expect, test } from "vitest";
import type { QueryParseResult, StreamQuery } from "./query.policy";
import { matchesLog, matchesTelemetry, parseStreamQuery } from "./query.policy";

function parse(search: string): QueryParseResult {
  return parseStreamQuery(new URLSearchParams(search));
}

function query(search: string): StreamQuery {
  const result = parse(search);
  if (!result.ok) throw new Error(`expected ${search} to parse, got ${result.reason}`);
  return result.query;
}

// The grammar table: every accepted param with a good and a bad value, plus
// the unknown-param rejection. Exact-match and time-window only, by ceiling.
const grammar: readonly [string, "ok" | "FILTER_UNKNOWN" | "FILTER_INVALID"][] = [
  ["", "ok"],
  ["projects=score", "ok"],
  ["projects=score,other&projects=third", "ok"],
  ["projects=", "FILTER_INVALID"],
  ["signals=snapshot,event,span,metric,log", "ok"],
  ["signals=trace", "FILTER_INVALID"],
  ["names=score.dispatch.decision", "ok"],
  ["names=", "FILTER_INVALID"],
  ["phases=dispatch,landing,repair,cleanup,maintenance", "ok"],
  ["phases=verify", "FILTER_INVALID"],
  ["outcomes=ok,error", "ok"],
  ["outcomes=success", "FILTER_INVALID"],
  ["trace_id=abc123", "ok"],
  ["trace_id=", "FILTER_INVALID"],
  ["subject_kind=issue&subject_id=40", "ok"],
  ["subject_kind=pull_request&subject_id=41", "ok"],
  ["subject_kind=session&subject_id=s1", "ok"],
  ["subject_kind=branch&subject_id=b1", "ok"],
  ["subject_kind=commit&subject_id=1", "FILTER_INVALID"],
  ["subject_kind=issue", "FILTER_INVALID"],
  ["subject_id=40", "FILTER_INVALID"],
  ["since=2026-08-15T00:00:00Z", "ok"],
  // `+` must be percent-encoded in a query string; bare it decodes to a space.
  ["since=2026-08-15T00:00:00.250%2B02:00", "ok"],
  ["since=2026-08-15T00:00:00.250+02:00", "FILTER_INVALID"],
  ["since=yesterday", "FILTER_INVALID"],
  // Date.parse would normalize this into March; the grammar must not.
  ["since=2026-02-30T00:00:00Z", "FILTER_INVALID"],
  ["since=2026-08-15T24:00:00Z", "FILTER_INVALID"],
  ["since=2026-08-15", "FILTER_INVALID"],
  ["until=2026-08-15T23:59:59Z", "ok"],
  ["until=2026-13-40T00:00:00Z", "FILTER_INVALID"],
  ["follow=true", "ok"],
  ["follow=false", "ok"],
  ["follow=yes", "FILTER_INVALID"],
  ["project=score", "FILTER_UNKNOWN"],
  ["q=merge", "FILTER_UNKNOWN"],
  ["limit=10", "FILTER_UNKNOWN"],
];

describe("filter grammar", () => {
  for (const [search, expected] of grammar) {
    test(`?${search} → ${expected}`, () => {
      const result = parse(search);
      if (expected === "ok") expect(result.ok).toBe(true);
      else expect(result).toEqual({ ok: false, reason: expected });
    });
  }

  test("follow defaults to true (the epic's stay-open default)", () => {
    expect(query("").follow).toBe(true);
    expect(query("follow=false").follow).toBe(false);
  });

  test("comma lists and repeats accumulate", () => {
    expect(query("projects=a,b&projects=c").projects).toEqual(["a", "b", "c"]);
  });
});

function record(overrides: Partial<TelemetryRecord>): TelemetryRecord {
  return {
    v: 1,
    ts: "2026-08-15T11:59:01.000Z",
    project: "score",
    signal: "event",
    name: "score.dispatch.decision",
    subject: { issue_number: 40 },
    attributes: { decision: "started", trace_id: "trace-a" },
    ...overrides,
  } as TelemetryRecord;
}

const span = record({
  signal: "span",
  name: "score.phase",
  span_id: "s1",
  status: "error",
  subject: undefined,
  attributes: { phase: "landing", trace_id: "trace-a" },
} as Partial<TelemetryRecord>);

// The matching table: one row per filter dimension, hit and miss.
const matching: readonly [string, string, TelemetryRecord, boolean][] = [
  ["absent filters match everything", "", record({}), true],
  ["signal hit", "signals=event", record({}), true],
  ["signal miss", "signals=span,metric", record({}), false],
  ["name exact hit", "names=score.dispatch.decision", record({}), true],
  ["name is exact, never prefix", "names=score.dispatch", record({}), false],
  ["phase from decision name", "phases=dispatch", record({}), true],
  ["phase from span attribute", "phases=landing", span, true],
  ["phase miss excludes", "phases=repair", span, false],
  ["outcome from span status", "outcomes=error", span, true],
  ["outcome filter excludes records without one", "outcomes=ok", record({}), false],
  ["trace hit", "trace_id=trace-a", record({}), true],
  ["trace miss", "trace_id=trace-b", record({}), false],
  [
    "trace filter excludes traceless records",
    "trace_id=trace-a",
    record({ attributes: {} }),
    false,
  ],
  ["issue subject hit", "subject_kind=issue&subject_id=40", record({}), true],
  ["issue subject miss", "subject_kind=issue&subject_id=41", record({}), false],
  [
    "pull_request subject hit",
    "subject_kind=pull_request&subject_id=41",
    record({ subject: { pull_request_number: 41 } }),
    true,
  ],
  [
    "session subject hit",
    "subject_kind=session&subject_id=s-alpha",
    record({ subject: { session: "s-alpha" } }),
    true,
  ],
  [
    "branch subject miss on subjectless record",
    "subject_kind=branch&subject_id=topic",
    span,
    false,
  ],
  ["since includes the boundary", "since=2026-08-15T11:59:01Z", record({}), true],
  ["since excludes older", "since=2026-08-15T11:59:02Z", record({}), false],
  ["until includes the boundary", "until=2026-08-15T11:59:01Z", record({}), true],
  ["until excludes newer", "until=2026-08-15T11:59:00Z", record({}), false],
  [
    "window excludes an unparseable timestamp",
    "since=2026-08-15T00:00:00Z",
    record({ ts: "not a time" }),
    false,
  ],
];

describe("telemetry matching", () => {
  for (const [label, search, input, expected] of matching) {
    test(label, () => {
      expect(matchesTelemetry(query(search), input)).toBe(expected);
    });
  }
});

describe("log matching", () => {
  const line = { project: "score", ts: "2026-08-15T11:59:05.000Z", level: "info", body: "tick" };

  test("selected by default and by signals=log, bounded by the window", () => {
    expect(matchesLog(query(""), line)).toBe(true);
    expect(matchesLog(query("signals=log"), line)).toBe(true);
    expect(matchesLog(query("signals=event"), line)).toBe(false);
    expect(matchesLog(query("since=2026-08-15T12:00:00Z"), line)).toBe(false);
    expect(matchesLog(query("until=2026-08-15T12:00:00Z"), line)).toBe(true);
  });

  test("telemetry-only filters exclude the prose source, never guess from text", () => {
    for (const search of [
      "names=score.tick",
      "phases=dispatch",
      "outcomes=ok",
      "trace_id=trace-a",
      "subject_kind=issue&subject_id=40",
    ]) {
      expect(matchesLog(query(search), line)).toBe(false);
    }
  });
});
