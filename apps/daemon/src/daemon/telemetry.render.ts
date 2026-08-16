/**
 * Pure mapping from phase results to telemetry event records (#78). No I/O,
 * no clock, no phase-service imports — inputs are the result types only; the
 * #79 wiring supplies project, timestamp, and the pass's dry-run flag at
 * composition. Names come from the epic's event table (#83); a tag or reason
 * this module does not recognize at runtime maps to `score.<phase>.unknown`
 * with the original value kept as an attribute — a record is kept, never
 * dropped.
 */

import type { CleanupResult } from "@score/core/cleanup/cleanup-result.interface";
import type { DispatchResult } from "@score/core/dispatch/dispatch-result.interface";
import type { LandingResult } from "@score/core/landing/change.interface";
import type { MaintenanceTickResult } from "@score/core/maintenance/maintenance.service";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import type { TelemetryEvent, TelemetrySubject } from "@score/core/telemetry/telemetry.interface";
import { TELEMETRY_VERSION } from "@score/core/telemetry/telemetry.interface";

/** Everything a pure mapper cannot know; the composition caller supplies it. */
export interface TelemetryRenderContext {
  readonly project: string;
  /** RFC 3339; the mapper never reads a clock. */
  readonly ts: string;
  /** The pass's flag — every record of a dry-run pass carries `dry_run: true`. */
  readonly dryRun: boolean;
}

function decisionEvent(
  ctx: TelemetryRenderContext,
  name: string,
  subject: TelemetrySubject,
  attributes: Record<string, string | number | boolean>,
  body?: string,
): TelemetryEvent {
  return {
    v: TELEMETRY_VERSION,
    ts: ctx.ts,
    project: ctx.project,
    signal: "event",
    name,
    subject,
    attributes: { ...attributes, dry_run: ctx.dryRun },
    ...(body === undefined ? {} : { body }),
  };
}

// The enum members known at branch time. Later-PR additions are later mapping
// additions; until then an unlisted member routes to `score.<phase>.unknown`.
const CLEANUP_ACTIONS: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "BLOCKED_DIRTY",
  "PLANNED",
  "CLEANED",
  "STRANDED_PINGED",
  "STRANDED_RECLAIMED",
  "STRANDED_DIRTY",
  "STRANDED_RESPAWNED",
  "AUTO_PULL_REFUSED",
]);

const DISPATCH_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "DEPENDENCY_INCOMPLETE",
  "ALREADY_IN_FLIGHT",
]);

const LANDING_TAGS: ReadonlySet<string> = new Set([
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
]);

const REPAIR_ACTIONS: ReadonlySet<string> = new Set([
  "NOT_NEEDED",
  "PINGED",
  "SPAWNED",
  "SKIPPED",
  "WORKING",
]);

export function renderCleanupTelemetry(
  result: CleanupResult,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  // Stranded results are keyed by issue — there is no PR number to report
  // (#64); an auto-pull refusal is about the primary checkout and has no
  // subject at all (#91).
  const subject: TelemetrySubject =
    "issueNumber" in result
      ? { issue_number: result.issueNumber }
      : "pullRequestNumber" in result
        ? { pull_request_number: result.pullRequestNumber }
        : {};
  const name = CLEANUP_ACTIONS.has(result.action)
    ? "score.cleanup.decision"
    : "score.cleanup.unknown";
  return [decisionEvent(ctx, name, subject, { action: result.action }, result.message)];
}

export function renderDispatchTelemetry(
  result: DispatchResult,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  const records: TelemetryEvent[] = [];
  for (const issue of result.started)
    records.push(
      decisionEvent(
        ctx,
        "score.dispatch.decision",
        { issue_number: issue },
        { decision: "started" },
      ),
    );
  for (const issue of result.planned)
    records.push(
      decisionEvent(
        ctx,
        "score.dispatch.decision",
        { issue_number: issue },
        { decision: "planned" },
      ),
    );
  // One record per (issue, reason): the reason stays a single queryable code,
  // never a joined string.
  for (const block of result.blocked)
    for (const reason of block.reasons)
      records.push(
        decisionEvent(
          ctx,
          DISPATCH_BLOCK_REASONS.has(reason) ? "score.dispatch.decision" : "score.dispatch.unknown",
          { issue_number: block.issueNumber },
          { decision: "blocked", reason },
        ),
      );
  for (const failure of result.failed)
    records.push(
      decisionEvent(
        ctx,
        "score.dispatch.decision",
        { issue_number: failure.issueNumber },
        { decision: "failed" },
        failure.message,
      ),
    );
  return records;
}

export function renderLandingTelemetry(
  result: LandingResult,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  const name = LANDING_TAGS.has(result.tag) ? "score.landing.decision" : "score.landing.unknown";
  return [
    decisionEvent(
      ctx,
      name,
      { pull_request_number: result.pullRequestNumber },
      { tag: result.tag },
      result.note,
    ),
  ];
}

export function renderRepairTelemetry(
  result: RepairResult,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  const name = REPAIR_ACTIONS.has(result.action) ? "score.repair.decision" : "score.repair.unknown";
  // result.target is omitted on purpose: it can hold a worktree path, and
  // absolute paths never enter telemetry (epic attribute-safety rule).
  return [
    decisionEvent(
      ctx,
      name,
      { pull_request_number: result.pullRequestNumber },
      { action: result.action },
    ),
  ];
}

export function renderMaintenanceTickTelemetry(
  result: MaintenanceTickResult,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  return [
    ...result.cleanup.flatMap((cleanup) => renderCleanupTelemetry(cleanup, ctx)),
    ...renderDispatchTelemetry(result.dispatch, ctx),
  ];
}
