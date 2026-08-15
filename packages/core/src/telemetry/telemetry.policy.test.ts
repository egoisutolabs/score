import { createWorkIdentity, sessionNameForIssue } from "@score/core/dispatch/dispatch.identity";
import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import type { TelemetryRecord } from "@score/core/telemetry/telemetry.interface";
import {
  attributeViolations,
  isValidMetricLabelValue,
  isValidTelemetryName,
  metricLabelViolations,
  recordViolations,
} from "@score/core/telemetry/telemetry.policy";
import { expect, test } from "vitest";

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

test("record names are OTel-shaped under the score namespace", () => {
  expect(isValidTelemetryName("score.dispatch.blocked")).toBe(true);
  expect(isValidTelemetryName("score.telemetry.gap")).toBe(true);
  expect(isValidTelemetryName("Score.Dispatch")).toBe(false);
  expect(isValidTelemetryName("dispatch.blocked")).toBe(false);
  expect(isValidTelemetryName("score.")).toBe(false);
  expect(isValidTelemetryName("score.dispatch..blocked")).toBe(false);
});

test("metric labels accept low-cardinality outcome values", () => {
  for (const value of ["blocked", "merged", "cursor-expired", "rate_limited", "landing"]) {
    expect(isValidMetricLabelValue(value), value).toBe(true);
  }
});

test("metric labels reject subject IDs, paths, SHAs, and free text", () => {
  const rejected = [
    identity.sessionName, // subject session ID from dispatch identity
    identity.branch, // subject branch from dispatch identity
    sessionNameForIssue(undefined, 12),
    "/Users/op/.score/projects/demo", // path
    "packages/core/src", // path
    "0123456789abcdef0123456789abcdef01234567", // SHA
    "deadbeefcafe", // short hex run, still SHA-shaped
    "Fix the flaky landing test", // free text
    "a-very-long-free-text-value-that-goes-on-and-on",
    "53", // a bare subject number is an unbounded per-subject series
    "",
  ];
  for (const value of rejected) {
    expect(isValidMetricLabelValue(value), JSON.stringify(value)).toBe(false);
  }
  expect(metricLabelViolations({ outcome: identity.sessionName })).toHaveLength(1);
  expect(metricLabelViolations({ outcome: "blocked" })).toHaveLength(0);
  // Subject identity as a label *key* is identity in metrics all the same.
  for (const key of ["issue_number", "pull_request_number", "session", "branch", "sha"]) {
    expect(metricLabelViolations({ [key]: "x" }), key).not.toEqual([]);
  }
});

test("attributes allow high-cardinality identity — that is where it belongs", () => {
  expect(
    attributeViolations({
      session: identity.sessionName,
      branch: identity.branch,
      sha: "0123456789abcdef0123456789abcdef01234567",
      outcome: "blocked",
      attempt: 3,
      dry_run: false,
    }),
  ).toEqual([]);
});

test("redaction rejects prompts, tokens, environment values, and payloads", () => {
  const secretShaped: Record<string, string> = {
    value_github: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    value_api: "sk-proj-abc123",
    value_bearer: "Bearer eyJhbGciOiJIUzI1NiJ9",
    value_env: "GITHUB_TOKEN=ghp_abc",
    value_pem: "-----BEGIN OPENSSH PRIVATE KEY-----",
  };
  for (const [label, value] of Object.entries(secretShaped)) {
    expect(attributeViolations({ note: value }), label).not.toEqual([]);
  }
  // Categorical keys are rejected regardless of value.
  for (const key of ["prompt", "payload", "api_key", "auth.token", "environment"]) {
    expect(attributeViolations({ [key]: "harmless" }), key).not.toEqual([]);
  }
  // Arbitrary payloads: an oversized value is rejected even under a clean key.
  expect(attributeViolations({ note: "x".repeat(300) })).not.toEqual([]);
  // Non-finite numbers would be stored as JSON null, outside the declared contract.
  expect(attributeViolations({ count: Number.NaN })).not.toEqual([]);
  expect(attributeViolations({ count: Number.POSITIVE_INFINITY })).not.toEqual([]);
});

test("recordViolations gates version, name, kind, and attributes together", () => {
  const good: TelemetryRecord = {
    version: 1,
    time: "2026-08-15T12:00:00.000Z",
    name: "score.dispatch.blocked",
    kind: "event",
    resource: { project: "demo" },
    subject: { session: identity.sessionName, branch: identity.branch },
    attributes: { outcome: "blocked" },
  };
  expect(recordViolations(good)).toEqual([]);
  expect(recordViolations({ ...good, version: 2 })).not.toEqual([]);
  expect(recordViolations({ ...good, name: "not a name" })).not.toEqual([]);
  expect(recordViolations({ ...good, attributes: { prompt: "do the thing" } })).not.toEqual([]);
  // Only ISO 8601 UTC timestamps keep records orderable across readers.
  expect(recordViolations({ ...good, time: "not-a-time" })).not.toEqual([]);
  expect(recordViolations({ ...good, time: new Date(0).toString() })).not.toEqual([]);
  expect(recordViolations({ ...good, time: "2026-08-15T12:00:00Z" })).toEqual([]);
});
