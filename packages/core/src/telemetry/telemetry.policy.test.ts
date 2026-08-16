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

const valid: TelemetryEvent = {
  v: 1,
  ts: "2026-08-15T12:00:00Z",
  signal: "event",
  name: "score.dispatch.blocked",
  project: "demo",
};

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
    [{ ts: "2026-08-15T12:00:00+24:00" }, "ts offset"],
    [{ signal: "log" as never }, "signal"],
    [{ name: "dispatch.blocked" }, "name"],
    [{ project: "" }, "project"],
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

  // The gate rejects an unbounded body outright — boundBody owns truncation.
  expect(recordViolations({ ...valid, body: "a".repeat(MAX_BODY_BYTES + 1) })).not.toEqual([]);
  const { body, truncated } = bounded;
  expect(recordViolations({ ...valid, body, truncated })).toEqual([]);
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
    "key=deadbeef",
    "token=ghs_short",
    "password=hunter2",
    "secret=s3cr3t",
    "api_key=abc", // *_key= pair
    "GITHUB_TOKEN=ghp_x", // *_token= pair
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
    "0123456789abcdef0123456789abcdef01234567", // a bare SHA is legitimate event identity
    identity.branch,
  ];
  for (const value of accepted) {
    expect(attributeViolations({ detail: value }), value).toEqual([]);
  }
});

test("attributes named *_token/*_key/*_secret/*_password are rejected whatever they hold", () => {
  for (const key of ["github_token", "api_key", "client_secret", "db_password"]) {
    expect(attributeViolations({ [key]: "harmless" }), key).not.toEqual([]);
  }
  for (const key of ["token_count", "keyboard", "secretary", "passwords_rotated"]) {
    expect(attributeViolations({ [key]: "harmless" }), key).toEqual([]);
  }
  // NaN/Infinity would serialize as null, outside the declared value types.
  expect(attributeViolations({ duration_ms: Number.NaN })).not.toEqual([]);
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
});
