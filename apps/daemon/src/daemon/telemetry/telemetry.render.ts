import { randomBytes } from "node:crypto";
import type { LandingResult } from "@score/core/landing/change.interface";
import type { MaintenanceTickResult } from "@score/core/maintenance/maintenance.service";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import type {
  TelemetryAttributes,
  TelemetryEvent,
  TelemetryResource,
  TelemetrySpan,
  TelemetrySubject,
} from "@score/core/telemetry/telemetry.interface";
import { TELEMETRY_VERSION } from "@score/core/telemetry/telemetry.interface";

/**
 * Mapping of the typed phase results the daemon already holds at composition
 * into OTel-shaped telemetry records (#54). Pure shaping only: no writer, no
 * clock, no phase imports — every name, attribute, and subject is decided
 * here and nothing else in the daemon mints records. Action and reason
 * attribute values are copied verbatim from the result enums; free text
 * (messages, notes, targets) never enters a record — v1 has no bounded body
 * field, so the prose log keeps that detail.
 */

/** OTel field names carried as attributes on every record of one pass. */
export interface TickTrace {
  readonly trace_id: string;
  readonly span_id: string;
  readonly tick_number: number;
}

/** A phase child span's identity; `parent_span_id` is the tick span's id. */
export interface PhaseTrace extends TickTrace {
  readonly phase: string;
  readonly parent_span_id: string;
}

export interface TelemetryEnv {
  readonly resource: TelemetryResource;
  /** Set on every record — a record without it could be aggregated as a real mutation. */
  readonly dry_run: boolean;
}

export type TickOutcome = "ok" | "error";
/** "suppressed" is reserved for the landing phase skipped by D1 reconciliation. */
export type PhaseOutcome = "ok" | "error" | "suppressed";

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function correlation(trace: TickTrace, env: TelemetryEnv): TelemetryAttributes {
  return {
    trace_id: trace.trace_id,
    "score.tick.number": trace.tick_number,
    "score.dry_run": env.dry_run,
  };
}

function event(
  name: string,
  time: string,
  env: TelemetryEnv,
  subject: TelemetrySubject,
  attributes: TelemetryAttributes,
): TelemetryEvent {
  return {
    version: TELEMETRY_VERSION,
    time,
    name,
    kind: "event",
    resource: env.resource,
    subject,
    attributes,
  };
}

export function tickSpanRecord(input: {
  readonly trace: TickTrace;
  readonly env: TelemetryEnv;
  readonly started_at: number;
  readonly ended_at: number;
  readonly time: string;
  readonly outcome: TickOutcome;
}): TelemetrySpan {
  return {
    version: TELEMETRY_VERSION,
    time: input.time,
    name: "score.tick",
    kind: "span",
    resource: input.env.resource,
    span_id: input.trace.span_id,
    duration_ms: input.ended_at - input.started_at,
    status: input.outcome,
    attributes: { ...correlation(input.trace, input.env), "score.outcome": input.outcome },
  };
}

export function phaseSpanRecord(input: {
  readonly trace: PhaseTrace;
  readonly env: TelemetryEnv;
  readonly started_at: number;
  readonly ended_at: number;
  readonly time: string;
  readonly outcome: PhaseOutcome;
  readonly error_type?: string;
}): TelemetrySpan {
  return {
    version: TELEMETRY_VERSION,
    time: input.time,
    name: "score.phase",
    kind: "span",
    resource: input.env.resource,
    span_id: input.trace.span_id,
    parent_span_id: input.trace.parent_span_id,
    duration_ms: input.ended_at - input.started_at,
    // A suppressed phase is a deliberate guard, not a failure.
    status: input.outcome === "error" ? "error" : "ok",
    attributes: {
      ...correlation(input.trace, input.env),
      "score.phase.name": input.trace.phase,
      "score.outcome": input.outcome,
      ...(input.error_type !== undefined && { "error.type": input.error_type }),
    },
  };
}

/**
 * Cleanup then dispatch, in renderMaintenanceTick's order. Merged-PR results
 * key on the PR; stranded-issue results key on the issue — there is no PR
 * number to report on that ladder.
 */
export function maintenanceDecisionEvents(
  result: MaintenanceTickResult,
  phase: PhaseTrace,
  env: TelemetryEnv,
  time: string,
): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  const base = {
    ...correlation(phase, env),
    span_id: phase.span_id,
    "score.phase.name": phase.phase,
  };
  for (const cleanup of result.cleanup) {
    const subject: TelemetrySubject =
      "pullRequestNumber" in cleanup
        ? { pull_request_number: cleanup.pullRequestNumber }
        : { issue_number: cleanup.issueNumber };
    events.push(
      event("score.cleanup.decision", time, env, subject, {
        ...base,
        "score.action": cleanup.action,
      }),
    );
  }
  for (const issueNumber of result.dispatch.started) {
    events.push(
      event(
        "score.dispatch.decision",
        time,
        env,
        { issue_number: issueNumber },
        {
          ...base,
          "score.action": "started",
        },
      ),
    );
  }
  for (const issueNumber of result.dispatch.planned) {
    events.push(
      event(
        "score.dispatch.decision",
        time,
        env,
        { issue_number: issueNumber },
        {
          ...base,
          "score.action": "planned",
        },
      ),
    );
  }
  for (const block of result.dispatch.blocked) {
    events.push(
      event(
        "score.dispatch.decision",
        time,
        env,
        { issue_number: block.issueNumber },
        {
          ...base,
          "score.action": "blocked",
          // The reason enum is closed and low-cardinality; free text never joins it.
          "score.reason": block.reasons.join(","),
        },
      ),
    );
  }
  for (const failure of result.dispatch.failed) {
    events.push(
      event(
        "score.dispatch.decision",
        time,
        env,
        { issue_number: failure.issueNumber },
        {
          ...base,
          "score.action": "failed",
        },
      ),
    );
  }
  return events;
}

export function landingDecisionEvents(
  results: readonly LandingResult[],
  phase: PhaseTrace,
  env: TelemetryEnv,
  time: string,
): TelemetryEvent[] {
  return results.map((result) =>
    event(
      "score.landing.decision",
      time,
      env,
      { pull_request_number: result.pullRequestNumber },
      {
        ...correlation(phase, env),
        span_id: phase.span_id,
        "score.phase.name": phase.phase,
        "score.action": result.tag,
      },
    ),
  );
}

export function repairDecisionEvents(
  results: readonly RepairResult[],
  phase: PhaseTrace,
  env: TelemetryEnv,
  time: string,
): TelemetryEvent[] {
  return results.map((result) =>
    event(
      "score.repair.decision",
      time,
      env,
      { pull_request_number: result.pullRequestNumber },
      {
        ...correlation(phase, env),
        span_id: phase.span_id,
        "score.phase.name": phase.phase,
        "score.action": result.action,
      },
    ),
  );
}
