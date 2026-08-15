import type { LandingResult } from "@score/core/landing/change.interface";
import type { MaintenanceTickResult } from "@score/core/maintenance/maintenance.service";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import type {
  TelemetryEvent,
  TelemetryRecord,
  TelemetrySpan,
} from "@score/core/telemetry/telemetry.interface";
import { expect, test } from "vitest";
import {
  landingDecisionEvents,
  maintenanceDecisionEvents,
  newSpanId,
  newTraceId,
  phaseSpanRecord,
  repairDecisionEvents,
  tickSpanRecord,
} from "./telemetry.render";

const TIME = "2026-08-15T12:00:00.000Z";
const ENV = { resource: { project: "demo", daemon_pid: 4242 }, dry_run: false };
const DRY_ENV = { ...ENV, dry_run: true };

function phase(parentSpanId: string) {
  return {
    trace_id: "trace0",
    span_id: "phase0",
    tick_number: 3,
    phase: "cleanup+dispatch",
    parent_span_id: parentSpanId,
  };
}

function decisionOf(record: TelemetryEvent): {
  name: string;
  subject: TelemetryEvent["subject"];
  action: string;
} {
  expect(record.kind).toBe("event");
  return {
    name: record.name,
    subject: record.subject,
    action: String(record.attributes?.["score.action"]),
  };
}

test("ids are OTel-shaped: 32-hex trace, 16-hex span", () => {
  expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
});

test("the tick root span record carries correlation and outcome", () => {
  const span = tickSpanRecord({
    trace: { trace_id: "trace0", span_id: "tick0", tick_number: 3 },
    env: ENV,
    started_at: 1000,
    ended_at: 2500,
    time: TIME,
    outcome: "ok",
  });
  expect(span).toEqual({
    version: 1,
    time: TIME,
    name: "score.tick",
    kind: "span",
    resource: ENV.resource,
    span_id: "tick0",
    duration_ms: 1500,
    status: "ok",
    attributes: {
      trace_id: "trace0",
      "score.tick.number": 3,
      "score.dry_run": false,
      "score.outcome": "ok",
    },
  });
});

test("a phase span record parents to the tick span and mirrors its outcome", () => {
  const base = {
    trace: phase("tick0"),
    env: ENV,
    started_at: 1000,
    ended_at: 1200,
    time: TIME,
  } as const;
  expect(phaseSpanRecord({ ...base, outcome: "ok" })).toEqual({
    version: 1,
    time: TIME,
    name: "score.phase",
    kind: "span",
    resource: ENV.resource,
    span_id: "phase0",
    parent_span_id: "tick0",
    duration_ms: 200,
    status: "ok",
    attributes: {
      trace_id: "trace0",
      "score.tick.number": 3,
      "score.dry_run": false,
      "score.phase.name": "cleanup+dispatch",
      "score.outcome": "ok",
    },
  });
  // A suppressed phase is a deliberate guard, not a failure.
  expect(phaseSpanRecord({ ...base, outcome: "suppressed" })).toMatchObject({
    status: "ok",
    attributes: { "score.outcome": "suppressed" },
  });
  expect(phaseSpanRecord({ ...base, outcome: "error", error_type: "Error" })).toMatchObject({
    status: "error",
    attributes: { "score.outcome": "error", "error.type": "Error" },
  });
});

const IDLE_CAPACITY = { active: 0, max: 2, heldBy: [], starved: false };

test("cleanup decisions cover every merged-PR and stranded action with the right subject", () => {
  const result: MaintenanceTickResult = {
    cleanup: [
      { pullRequestNumber: 1, action: "CLEANED" },
      { pullRequestNumber: 2, action: "PLANNED" },
      { pullRequestNumber: 3, action: "BLOCKED_DIRTY", message: "dirty" },
      { pullRequestNumber: 4, action: "NOT_FOUND" },
      { issueNumber: 5, action: "STRANDED_PINGED", dryRun: false },
      { issueNumber: 6, action: "STRANDED_RECLAIMED", dryRun: false },
      { issueNumber: 7, action: "STRANDED_DIRTY", dryRun: false, message: "dirt" },
      { issueNumber: 8, action: "STRANDED_RESPAWNED", dryRun: false },
    ],
    dispatch: { started: [], planned: [], blocked: [], failed: [], capacity: IDLE_CAPACITY },
  };
  const events = maintenanceDecisionEvents(result, phase("tick0"), ENV, TIME).map(decisionOf);
  expect(events).toEqual([
    { name: "score.cleanup.decision", subject: { pull_request_number: 1 }, action: "CLEANED" },
    { name: "score.cleanup.decision", subject: { pull_request_number: 2 }, action: "PLANNED" },
    {
      name: "score.cleanup.decision",
      subject: { pull_request_number: 3 },
      action: "BLOCKED_DIRTY",
    },
    { name: "score.cleanup.decision", subject: { pull_request_number: 4 }, action: "NOT_FOUND" },
    { name: "score.cleanup.decision", subject: { issue_number: 5 }, action: "STRANDED_PINGED" },
    { name: "score.cleanup.decision", subject: { issue_number: 6 }, action: "STRANDED_RECLAIMED" },
    { name: "score.cleanup.decision", subject: { issue_number: 7 }, action: "STRANDED_DIRTY" },
    { name: "score.cleanup.decision", subject: { issue_number: 8 }, action: "STRANDED_RESPAWNED" },
  ]);
});

test("dispatch decisions cover started, planned, blocked (both reasons), and failed", () => {
  const result: MaintenanceTickResult = {
    cleanup: [],
    dispatch: {
      started: [11],
      planned: [12],
      blocked: [
        { issueNumber: 13, reasons: ["DEPENDENCY_INCOMPLETE"] },
        { issueNumber: 14, reasons: ["ALREADY_IN_FLIGHT", "DEPENDENCY_INCOMPLETE"] },
      ],
      failed: [{ issueNumber: 15, message: "git died" }],
      capacity: { active: 0, max: 2, heldBy: [], starved: false },
    },
  };
  const events = maintenanceDecisionEvents(result, phase("tick0"), ENV, TIME).map(decisionOf);
  expect(events).toEqual([
    { name: "score.dispatch.decision", subject: { issue_number: 11 }, action: "started" },
    { name: "score.dispatch.decision", subject: { issue_number: 12 }, action: "planned" },
    { name: "score.dispatch.decision", subject: { issue_number: 13 }, action: "blocked" },
    { name: "score.dispatch.decision", subject: { issue_number: 14 }, action: "blocked" },
    { name: "score.dispatch.decision", subject: { issue_number: 15 }, action: "failed" },
  ]);
  // The blocked reason enum rides along verbatim; a dispatch failure's free
  // text never enters the record.
  const full = maintenanceDecisionEvents(result, phase("tick0"), ENV, TIME);
  expect(full[2]?.attributes?.["score.reason"]).toBe("DEPENDENCY_INCOMPLETE");
  expect(full[3]?.attributes?.["score.reason"]).toBe("ALREADY_IN_FLIGHT,DEPENDENCY_INCOMPLETE");
  expect(JSON.stringify(full[4])).not.toContain("git died");
});

test("landing decisions cover every landing tag", () => {
  const tags = [
    "skipped",
    "would-merge",
    "conflict",
    "changes-requested",
    "checks-red",
    "checks-pending",
    "unresolved",
    "build-red",
    "soaking",
    "ready",
    "push-failed",
    "merged",
  ] as const;
  const results: LandingResult[] = tags.map((tag, index) => ({
    pullRequestNumber: 20 + index,
    tag,
    note: `note for ${tag}`,
  }));
  const events = landingDecisionEvents(results, phase("tick0"), ENV, TIME).map(decisionOf);
  expect(events).toEqual(
    tags.map((tag, index) => ({
      name: "score.landing.decision",
      subject: { pull_request_number: 20 + index },
      action: tag,
    })),
  );
  // Notes are free text and stay out of the record.
  const serialized = JSON.stringify(landingDecisionEvents(results, phase("tick0"), ENV, TIME));
  expect(serialized).not.toContain("note for");
});

test("repair decisions cover every repair action", () => {
  const actions = ["NOT_NEEDED", "PINGED", "SPAWNED", "SKIPPED", "WORKING"] as const;
  const results: RepairResult[] = actions.map((action, index) => ({
    pullRequestNumber: 40 + index,
    action,
    dryRun: false,
    target: index === 1 ? "score-demo-issue-1" : undefined,
  }));
  const events = repairDecisionEvents(results, phase("tick0"), ENV, TIME).map(decisionOf);
  expect(events).toEqual(
    actions.map((action, index) => ({
      name: "score.repair.decision",
      subject: { pull_request_number: 40 + index },
      action,
    })),
  );
  // Session/worktree targets never enter the record.
  const serialized = JSON.stringify(repairDecisionEvents(results, phase("tick0"), ENV, TIME));
  expect(serialized).not.toContain("score-demo-issue-1");
});

test("decision events correlate to their phase span, which parents to the tick span", () => {
  const trace = phase("tick0");
  const events = maintenanceDecisionEvents(
    {
      cleanup: [{ pullRequestNumber: 1, action: "CLEANED" }],
      dispatch: { started: [], planned: [], blocked: [], failed: [], capacity: IDLE_CAPACITY },
    },
    trace,
    ENV,
    TIME,
  );
  for (const event of events) {
    expect(event.attributes?.trace_id).toBe(trace.trace_id);
    expect(event.attributes?.span_id).toBe(trace.span_id);
    expect(event.attributes?.["score.phase.name"]).toBe(trace.phase);
  }
  const span = phaseSpanRecord({
    trace,
    env: ENV,
    started_at: 0,
    ended_at: 5,
    time: TIME,
    outcome: "ok",
  }) as TelemetrySpan;
  expect(span.attributes?.trace_id).toBe(trace.trace_id);
  expect(span.parent_span_id).toBe("tick0");
});

test("every record carries the dry-run marker — dry-run output cannot aggregate as real mutations", () => {
  const maintenance: MaintenanceTickResult = {
    cleanup: [{ pullRequestNumber: 2, action: "PLANNED" }],
    dispatch: { started: [], planned: [12], blocked: [], failed: [], capacity: IDLE_CAPACITY },
  };
  const landing: LandingResult[] = [{ pullRequestNumber: 30, tag: "would-merge", note: "" }];
  const repair: RepairResult[] = [
    { pullRequestNumber: 40, action: "PINGED", dryRun: true, target: "s" },
  ];
  const records: TelemetryRecord[] = [
    ...maintenanceDecisionEvents(maintenance, phase("tick0"), DRY_ENV, TIME),
    ...landingDecisionEvents(landing, phase("tick0"), DRY_ENV, TIME),
    ...repairDecisionEvents(repair, phase("tick0"), DRY_ENV, TIME),
    phaseSpanRecord({
      trace: phase("tick0"),
      env: DRY_ENV,
      started_at: 0,
      ended_at: 1,
      time: TIME,
      outcome: "ok",
    }),
    tickSpanRecord({
      trace: { trace_id: "trace0", span_id: "tick0", tick_number: 3 },
      env: DRY_ENV,
      started_at: 0,
      ended_at: 1,
      time: TIME,
      outcome: "ok",
    }),
  ];
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) expect(record.attributes?.["score.dry_run"]).toBe(true);
});

test("non-dry-run records carry an explicit false marker", () => {
  const [record] = landingDecisionEvents(
    [{ pullRequestNumber: 30, tag: "merged", note: "" }],
    phase("tick0"),
    ENV,
    TIME,
  );
  expect(record?.attributes?.["score.dry_run"]).toBe(false);
});
