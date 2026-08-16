import { createWorkIdentity, sessionNameForIssue } from "@score/core/dispatch/dispatch.identity";
import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import type { TelemetryEvent, TelemetryRecord } from "@score/core/telemetry/telemetry.interface";
import { METRIC_LABELS } from "@score/core/telemetry/telemetry.interface";
import {
  attributeViolations,
  boundBody,
  isValidTelemetryName,
  MAX_BODY_BYTES,
  metricLabelViolations,
  recordViolations,
} from "@score/core/telemetry/telemetry.policy";
import { expect, test } from "vitest";

// Fixture identity values: produced by dispatch.identity, carried byte-identical.
const issue: IssueObservation = {
  number: 74,
  title: "Telemetry record vocabulary and policy",
  body: "",
  labels: [],
  state: "OPEN",
  url: "https://github.com/egoisutolabs/score/issues/74",
  comments: [],
};
const identity = createWorkIdentity("/workspace", issue, "demo");

// satisfies (not an annotation) keeps the inferred type free of the optional
// fields, so spreads into metric literals don't drag `attributes?` along.
const valid = {
  v: 1,
  ts: "2026-08-15T12:00:00Z",
  signal: "event",
  name: "score.dispatch.blocked",
  project: "demo",
} satisfies TelemetryEvent;

// --- valid record ---

test("a record needs v: 1, an RFC 3339 ts, a signal, a score-namespaced name, and a project", () => {
  expect(recordViolations(valid)).toEqual([]);
  expect(
    recordViolations({ ...valid, signal: "span", name: "score.landing.tick", span_id: "s1" }),
  ).toEqual([]);
  expect(
    recordViolations({
      ...valid,
      signal: "metric",
      name: "score.dispatch.starts",
      value: 1,
      labels: { phase: "dispatch", outcome: "ok" },
    }),
  ).toEqual([]);
  // RFC 3339 admits fractional seconds and numeric offsets, not bare dates or spaces.
  expect(recordViolations({ ...valid, ts: "2026-08-15T12:00:00.250+02:00" })).toEqual([]);

  const rejected: readonly [Partial<TelemetryRecord>, string][] = [
    [{ v: 2 as never }, "version"],
    [{ ts: "2026-08-15" }, "ts"],
    [{ ts: "2026-08-15 12:00:00Z" }, "ts"],
    // Well-shaped but impossible components are still not RFC 3339 date-times.
    [{ ts: "2026-99-99T99:99:99+99:99" }, "ts components"],
    [{ ts: "2026-13-01T00:00:00Z" }, "ts month"],
    [{ ts: "2026-02-30T12:00:00Z" }, "ts day"],
    [{ ts: "2026-08-15T24:00:00Z" }, "ts hour"],
    [{ ts: "2026-08-15T12:00:60Z" }, "ts leap second — producers never emit :60"],
    [{ ts: "2026-08-15T12:00:00+24:00" }, "ts offset"],
    [{ signal: "log" as never }, "signal"],
    [{ name: "dispatch.blocked" }, "name"],
    [{ project: "" }, "project"],
    [{ project: 123 as never }, "truthy non-string project"],
    // Parsed, untrusted JSON can carry null where the type says object —
    // rejected as a violation, never a crash.
    [{ attributes: null as never }, "null attributes"],
  ];
  for (const [patch, why] of rejected) {
    expect(recordViolations({ ...valid, ...patch } as TelemetryRecord), why).not.toEqual([]);
  }
});

test("record names are OTel-shaped dotted names under the score namespace", () => {
  expect(isValidTelemetryName("score.dispatch.blocked")).toBe(true);
  expect(isValidTelemetryName("score.landing")).toBe(true);
  for (const name of ["score", "score.", "Score.Dispatch", "dispatch.blocked", "score..a"]) {
    expect(isValidTelemetryName(name), name).toBe(false);
  }
});

// --- bounded body ---

test("a body at the ceiling passes untouched; past it, truncated at the boundary with the marker", () => {
  const atCeiling = "a".repeat(MAX_BODY_BYTES);
  expect(boundBody(atCeiling)).toEqual({ body: atCeiling, truncated: false });

  const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
  const bounded = boundBody("a".repeat(MAX_BODY_BYTES + 1000));
  expect(bounded.truncated).toBe(true);
  expect(utf8Bytes(bounded.body)).toBe(MAX_BODY_BYTES);

  // The cut never tears a multi-byte code point: 3-byte "€" doesn't divide 4096.
  const multibyte = boundBody("€".repeat(2000));
  expect(multibyte.truncated).toBe(true);
  expect(utf8Bytes(multibyte.body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
  expect(multibyte.body).not.toContain("�");

  // Gate first, truncate second: an over-long body is not itself a violation
  // (boundBody bounds it for storage after acceptance)…
  expect(recordViolations({ ...valid, body: "a".repeat(MAX_BODY_BYTES + 1) })).toEqual([]);
  const { body, truncated } = bounded;
  expect(recordViolations({ ...valid, body, truncated })).toEqual([]);

  // …and the gate sees the FULL body, so a credential the truncation would
  // tear at the byte ceiling (leaving 35/36 secret chars stored) still rejects.
  const tornCredential = `${"a".repeat(MAX_BODY_BYTES - 21)} ghp_${"B".repeat(36)}`;
  expect(recordViolations({ ...valid, body: tornCredential })).not.toEqual([]);
});

test("the redaction table gates body text the same as attribute values", () => {
  for (const leak of [
    "request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.p.s",
    "retrying with token=ghs_abc123",
    "creds AKIAIOSFODNN7EXAMPLE in dumped env",
  ]) {
    expect(recordViolations({ ...valid, body: leak }), leak).not.toEqual([]);
  }
  expect(recordViolations({ ...valid, body: "plain stack trace, no credentials" })).toEqual([]);
});

test("a metric value must be finite — NaN/Infinity would serialize as null", () => {
  const metric = { ...valid, signal: "metric", name: "score.landing.duration_ms" } as const;
  expect(recordViolations({ ...metric, value: 12.5 })).toEqual([]);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(recordViolations({ ...metric, value }), String(value)).not.toEqual([]);
  }
});

test("span identifiers are non-empty and durations finite, non-negative", () => {
  const span = { ...valid, signal: "span", name: "score.landing.tick", span_id: "s1" } as const;
  expect(recordViolations({ ...span, parent_span_id: "s0", duration_ms: 42 })).toEqual([]);
  expect(recordViolations({ ...span, span_id: "" })).not.toEqual([]);
  // Untrusted JSON can carry null or a number where the type says string.
  for (const span_id of [null, 42, undefined]) {
    expect(recordViolations({ ...span, span_id: span_id as never }), String(span_id)).not.toEqual(
      [],
    );
  }
  expect(recordViolations({ ...span, parent_span_id: 7 as never })).not.toEqual([]);
  // Absence of a parent is an omitted field, never an empty string.
  expect(recordViolations({ ...span, parent_span_id: "" })).not.toEqual([]);
  for (const duration_ms of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    expect(recordViolations({ ...span, duration_ms }), String(duration_ms)).not.toEqual([]);
  }
});

// --- secret shapes: this table IS the spec ---

test("secret-shaped attribute values are rejected", () => {
  const rejected = [
    "AKIAIOSFODNN7EXAMPLE", // AWS access key ID
    "creds AKIAIOSFODNN7EXAMPLE embedded mid-string",
    `ghp_${"A1b2".repeat(9)}`, // GitHub classic PAT (36 chars)
    "github_pat_11ABCDEFG0abcdefghijklmnop", // GitHub fine-grained PAT
    `sk-${"a1B2c3d4e5".repeat(2)}`, // API secret key (20+ chars)
    "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "authorization: bearer eyJhbGciOiJIUzI1NiJ9.p.s", // auth schemes are case-insensitive
    "key=deadbeef",
    "token=ghs_short",
    "password=hunter2",
    "secret=s3cr3t",
    "api_key=abc", // *_key= pair
    "GITHUB_TOKEN=ghp_x", // *_token= pair
    "MyToken=abc123def456", // camelCase pair — uppercase-initial keyword is its own word
    "APIKey=abc123",
    "DBPassword=hunter2",
  ];
  for (const value of rejected) {
    expect(attributeViolations({ detail: value }), value).not.toEqual([]);
  }
});

test("near-miss values stay admitted — no entropy scanning past the declared shapes", () => {
  const accepted = [
    "AKIA1234", // too short for an access key ID
    "akiaiosfodnn7example", // wrong case
    "ghp_tooshort",
    "sk-short",
    "task-abcdefghijklmnopqrstuvwxyz", // contains "sk-" only inside another word
    "Bearer", // no token follows
    "monkey=banana", // "key=" only inside another word
    "Monkey=banana", // still one word — the keyword itself is lowercase mid-word
    "0123456789abcdef0123456789abcdef01234567", // a bare SHA is legitimate event identity
    identity.branch,
  ];
  for (const value of accepted) {
    expect(attributeViolations({ detail: value }), value).toEqual([]);
  }
});

test("attributes whose final segment names a credential are rejected whatever they hold", () => {
  const rejected = [
    "github_token", // suffixed
    "api_key",
    "client_secret",
    "db_password",
    "token", // bare
    "password",
    "auth.token", // dotted, OTel style
  ];
  for (const key of rejected) {
    expect(attributeViolations({ [key]: "harmless" }), key).not.toEqual([]);
  }
  for (const key of ["token_count", "keyboard", "secretary", "passwords_rotated"]) {
    expect(attributeViolations({ [key]: "harmless" }), key).toEqual([]);
  }
  // NaN/Infinity would serialize as null, outside the declared value types.
  expect(attributeViolations({ duration_ms: Number.NaN })).not.toEqual([]);
  // Non-scalar values reject — a nested object could smuggle a credential
  // past the string-shape scan.
  for (const value of [{ token: "ghp_x" }, ["ghp_x"], null]) {
    expect(attributeViolations({ detail: value as never }), JSON.stringify(value)).not.toEqual([]);
  }
  expect(attributeViolations({ ok: true, count: 3 })).toEqual([]);
  // Attributes are dimensions, not payloads — free detail belongs in body.
  expect(attributeViolations({ detail: "a".repeat(256) })).toEqual([]);
  expect(attributeViolations({ detail: "a".repeat(257) })).not.toEqual([]);
});

// --- metric-label policy: exhaustive over the declared enums ---

test("every declared enum member is accepted — the whole vocabulary", () => {
  for (const [key, members] of Object.entries(METRIC_LABELS)) {
    for (const member of members) {
      expect(metricLabelViolations({ [key]: member }), `${key}=${member}`).toEqual([]);
    }
  }
});

test("identifiers, paths, SHAs, free strings, and undeclared labels are rejected", () => {
  const rejectedValues = [
    identity.sessionName, // session identifier from dispatch identity
    identity.branch, // branch identifier
    sessionNameForIssue(undefined, 74),
    "74", // bare issue/PR number
    "/Users/op/.score/projects/demo", // path
    "0123456789abcdef0123456789abcdef01234567", // SHA
    "Fix the flaky landing test", // free string
    "",
  ];
  for (const value of rejectedValues) {
    expect(metricLabelViolations({ phase: value }), JSON.stringify(value)).not.toEqual([]);
    expect(metricLabelViolations({ outcome: value }), JSON.stringify(value)).not.toEqual([]);
  }
  for (const key of ["session", "branch", "issue", "pr", "sha"]) {
    expect(metricLabelViolations({ [key]: "dispatch" }), key).not.toEqual([]);
  }
});

test("a metric carries labels only — attributes would smuggle identity past the enums", () => {
  const metric = { ...valid, signal: "metric", name: "score.dispatch.starts", value: 1 } as const;
  expect(recordViolations(metric)).toEqual([]);
  const smuggled = { ...metric, attributes: { session: identity.sessionName } };
  expect(recordViolations(smuggled as unknown as TelemetryRecord)).not.toEqual([]);
  // null labels from untrusted JSON reject, never crash.
  const nullLabels = { ...metric, labels: null };
  expect(recordViolations(nullLabels as unknown as TelemetryRecord)).not.toEqual([]);
});

// --- identity ---

test("subject names produced by dispatch.identity pass through byte-identical", () => {
  const record: TelemetryEvent = {
    ...valid,
    name: "score.dispatch.started",
    subject: {
      session: identity.sessionName,
      branch: identity.branch,
      issue_number: identity.issueNumber,
    },
    attributes: { branch: identity.branch, session: identity.sessionName },
  };
  expect(recordViolations(record)).toEqual([]);
  // Byte-identical carriage: the values ARE dispatch.identity's output, unreformatted.
  expect(record.subject?.session).toBe(identity.sessionName);
  expect(record.subject?.branch).toBe(identity.branch);

  // Subject numbers must survive JSON — NaN/Infinity would store as null.
  expect(recordViolations({ ...valid, subject: { issue_number: Number.NaN } })).not.toEqual([]);
  expect(
    recordViolations({ ...valid, subject: { pull_request_number: Number.POSITIVE_INFINITY } }),
  ).not.toEqual([]);
});
