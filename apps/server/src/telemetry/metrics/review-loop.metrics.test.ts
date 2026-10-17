import type { TelemetryRecord } from "@score/core/telemetry/telemetry.interface";
import { expect, test } from "vitest";
import { renderReviewLoopMetrics, reviewLoopMetrics } from "./review-loop.metrics";

function event(
  name: string,
  pr: number | undefined,
  attributes: Record<string, string | number | boolean>,
): TelemetryRecord {
  return {
    v: 1,
    ts: "2026-10-16T00:00:00Z",
    project: "score",
    signal: "event",
    name,
    ...(pr !== undefined && { subject: { pull_request_number: pr } }),
    attributes,
  } as TelemetryRecord;
}

test("metrics segment PRs by the prompt version of their last wave and count the baseline figures", () => {
  const records = [
    event("score.dispatch.decision", undefined, { decision: "started", briefing_version: "b1" }),
    event("score.dispatch.decision", undefined, { decision: "started", briefing_version: "b1" }),
    // PR 9: two waves on v1, three findings (one late regression), merged with one open.
    event("score.repair.finding", 9, { class: "first-round", wave: 0 }),
    event("score.repair.wave", 9, { prompt_version: "v1", wave: 1 }),
    event("score.repair.finding", 9, { class: "regression-from-fix", wave: 1 }),
    event("score.repair.finding", 9, { class: "missed-earlier", wave: 1 }),
    event("score.repair.wave", 9, { prompt_version: "v1", wave: 2 }),
    event("score.repair.open_at_merge", 9, { open_findings: 1, total_findings: 3 }),
    // PR 10: one wave on v2, parked by rule 3.
    event("score.repair.wave", 10, { prompt_version: "v2", wave: 1 }),
    event("score.repair.finding", 10, { class: "fix-failed", wave: 1 }),
    event("score.repair.parked", 10, { rule: "regression-from-fix" }),
    // Noise: a span and an unrelated event change nothing.
    { ...event("score.phase", undefined, {}), signal: "span", span_id: "s" } as TelemetryRecord,
    event("score.cleanup.decision", 9, { action: "NOT_FOUND" }),
    // A dry-run pass sent nothing: its records are not loop behavior.
    event("score.repair.wave", 10, { prompt_version: "v2", wave: 2, dry_run: true }),
    event("score.repair.finding", 10, { class: "fix-failed", wave: 2, dry_run: true }),
    event("score.repair.parked", 10, { rule: "budget", dry_run: true }),
    event("score.repair.open_at_merge", 10, { open_findings: 5, dry_run: true }),
    event("score.dispatch.decision", undefined, {
      decision: "started",
      briefing_version: "b1",
      dry_run: true,
    }),
  ];
  const metrics = reviewLoopMetrics(records);
  expect(metrics.dispatchesByBriefing).toEqual({ b1: 2 });
  expect(metrics.segments).toEqual([
    {
      promptVersion: "none",
      pullRequests: 1,
      waves: 0,
      findings: 1,
      lateFindings: 0,
      lateRegressions: 0,
      parkedByRule: {},
      mergedPullRequests: 0,
      openAtMerge: 0,
    },
    {
      promptVersion: "v1",
      pullRequests: 1,
      waves: 2,
      findings: 2,
      lateFindings: 2,
      lateRegressions: 1,
      parkedByRule: {},
      mergedPullRequests: 1,
      openAtMerge: 1,
    },
    {
      promptVersion: "v2",
      pullRequests: 1,
      waves: 1,
      findings: 1,
      lateFindings: 1,
      lateRegressions: 1,
      parkedByRule: { "regression-from-fix": 1 },
      mergedPullRequests: 0,
      openAtMerge: 0,
    },
  ]);
  const table = renderReviewLoopMetrics(metrics);
  expect(table[0]).toContain("prompt_version");
  expect(table.find((line) => line.startsWith("v1"))).toContain("2.00");
  expect(table.find((line) => line.startsWith("v2"))).toContain("regression-from-fix=1");
});

test("metrics over no records are empty, not a crash", () => {
  expect(reviewLoopMetrics([])).toEqual({ segments: [], dispatchesByBriefing: {} });
  expect(renderReviewLoopMetrics(reviewLoopMetrics([])).at(-1)).toContain("none");
});
