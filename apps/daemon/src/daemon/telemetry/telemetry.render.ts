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
import {
  briefingVersionFor,
  IMPLEMENTATION_PROMPT_VERSION,
  REPAIR_PROMPT_VERSION,
} from "@score/core/prompts/index";
import type { FindingRecord } from "@score/core/repair/findings/finding.interface";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import type { WaveRecord } from "@score/core/repair/wave.interface";
import type { TelemetryEvent, TelemetrySubject } from "@score/core/telemetry/telemetry.interface";
import { TELEMETRY_VERSION } from "@score/core/telemetry/telemetry.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";

/** Everything a pure mapper cannot know; the composition caller supplies it. */
export interface TelemetryRenderContext {
  readonly project: string;
  /** RFC 3339; the mapper never reads a clock. */
  readonly ts: string;
  /** The pass's flag — every record of a dry-run pass carries `dry_run: true`. */
  readonly dryRun: boolean;
  /** The project's harness: the briefing an agent is sent differs by it, so its version does too. */
  readonly harness: AgentConfig["harness"];
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
  "settling",
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
  "CHECKS_PENDING",
  "UNOBSERVED",
  "EXHAUSTED",
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
  // The prompt versions ride the start record so online metrics can be
  // segmented by what the agent was actually told (analysis §3).
  for (const issue of result.started)
    records.push(
      decisionEvent(
        ctx,
        "score.dispatch.decision",
        { issue_number: issue },
        {
          decision: "started",
          briefing_version: briefingVersionFor(ctx.harness),
          implementation_prompt_version: IMPLEMENTATION_PROMPT_VERSION,
        },
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
  // failure.message is omitted on purpose: adapter errors embed absolute
  // worktree paths, and paths never enter telemetry (epic attribute-safety
  // rule) — the prose log keeps the full message.
  for (const failure of result.failed)
    records.push(
      decisionEvent(
        ctx,
        "score.dispatch.decision",
        { issue_number: failure.issueNumber },
        { decision: "failed" },
      ),
    );
  return records;
}

export function renderLandingTelemetry(
  result: LandingResult,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  const name = LANDING_TAGS.has(result.tag) ? "score.landing.decision" : "score.landing.unknown";
  // result.note is omitted on purpose: build-red notes carry raw gate output
  // and several tags interpolate error messages, both of which embed absolute
  // paths that never enter telemetry (epic attribute-safety rule) — the prose
  // log keeps the full note.
  return [
    decisionEvent(
      ctx,
      name,
      { pull_request_number: result.pullRequestNumber },
      { tag: result.tag },
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
  const sentPrompt = result.action === "PINGED" || result.action === "SPAWNED";
  return [
    decisionEvent(
      ctx,
      name,
      { pull_request_number: result.pullRequestNumber },
      {
        action: result.action,
        ...(sentPrompt && { repair_prompt_version: REPAIR_PROMPT_VERSION }),
      },
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

// Review-loop records (analysis §2, Phase 2 of the plan): the wave, the
// finding, the park, and what was still open at merge, all on the PR subject
// so one trace reads top to bottom. Paths here are repo-relative; absolute
// paths never enter telemetry.

export function renderRepairWaveTelemetry(
  pullRequestNumber: number,
  waveIndex: number,
  wave: WaveRecord,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  return [
    decisionEvent(
      ctx,
      "score.repair.wave",
      { pull_request_number: pullRequestNumber },
      {
        wave: waveIndex,
        open_findings: wave.openFindings,
        ...(wave.diffSize !== undefined && { diff_size: wave.diffSize }),
        ...(wave.headSha !== undefined && { head_sha: wave.headSha }),
        prompt_version: wave.promptVersion,
        conflicting: wave.defects.conflicting,
        unresolved_threads: wave.defects.unresolvedThreads,
        failing_checks: wave.defects.failingChecks,
        build_red: wave.defects.buildRed !== undefined,
      },
    ),
  ];
}

/** One record per finding, the pass it is first keyed; resolution changes are not re-emitted. */
export function renderFindingTelemetry(
  pullRequestNumber: number,
  finding: FindingRecord,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  return [
    decisionEvent(
      ctx,
      "score.repair.finding",
      { pull_request_number: pullRequestNumber },
      {
        thread_id: finding.threadId,
        // "key" is a secret-shaped attribute name to the policy; the content is a blame fingerprint.
        fingerprint: finding.key,
        class: finding.class,
        wave: finding.wave,
        from_last_fix: finding.fromLastFix,
        resolution: finding.resolution,
        path: finding.path,
        ...(finding.symbol !== undefined && { symbol: finding.symbol }),
        ...(finding.author !== undefined && { author: finding.author }),
        ...(finding.real !== undefined && { real: finding.real }),
      },
    ),
  ];
}

/** The rule's numbers go in the body: free text, bounded by the policy, never an attribute. */
export function renderParkedTelemetry(
  result: RepairResult,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  if (result.parked === undefined) return [];
  return [
    decisionEvent(
      ctx,
      "score.repair.parked",
      { pull_request_number: result.pullRequestNumber },
      { rule: result.parked.rule },
      result.parked.detail,
    ),
  ];
}

export function renderOpenAtMergeTelemetry(
  pullRequestNumber: number,
  openFindings: number,
  totalFindings: number,
  ctx: TelemetryRenderContext,
): readonly TelemetryEvent[] {
  return [
    decisionEvent(
      ctx,
      "score.repair.open_at_merge",
      { pull_request_number: pullRequestNumber },
      { open_findings: openFindings, total_findings: totalFindings },
    ),
  ];
}
