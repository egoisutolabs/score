import type { TelemetryRecord } from "@score/core/telemetry/telemetry.interface";

/**
 * Online review-loop metrics (analysis §3, tier 3) from the records the
 * daemon emits: rounds per PR, late-round regression share, findings open at
 * merge, and parks by rule — segmented by repair prompt version so a prompt
 * change is compared only against itself. Pure over records; the script and
 * the API read the segments.
 */
export interface ReviewLoopSegment {
  readonly promptVersion: string;
  readonly pullRequests: number;
  readonly waves: number;
  readonly findings: number;
  /** Findings first seen after wave one. */
  readonly lateFindings: number;
  /** Late findings classed fix-failed or regression-from-fix. */
  readonly lateRegressions: number;
  readonly parkedByRule: Readonly<Record<string, number>>;
  readonly mergedPullRequests: number;
  readonly openAtMerge: number;
}

export interface ReviewLoopMetrics {
  readonly segments: readonly ReviewLoopSegment[];
  /** Dispatches per briefing version, for the briefing's own prevention metric. */
  readonly dispatchesByBriefing: Readonly<Record<string, number>>;
}

interface Tally {
  promptVersion: string;
  pullRequests: Set<number>;
  waves: number;
  findings: number;
  lateFindings: number;
  lateRegressions: number;
  /** PRs, not park events: a PR granted a fresh budget and parked again is one PR that failed to converge. */
  parkedByRule: Map<string, Set<number>>;
  merged: Set<number>;
  openAtMerge: number;
}

const LATE_REGRESSION_CLASSES = new Set(["fix-failed", "regression-from-fix"]);

export function reviewLoopMetrics(records: readonly TelemetryRecord[]): ReviewLoopMetrics {
  const tallies = new Map<string, Tally>();
  // Every record of a PR — its first-round findings included — is attributed
  // to the prompt version of the last wave it received, so the version is
  // settled over all records before any is tallied; a PR with no wave in the
  // window lands under "none".
  const versionByPullRequest = new Map<number, string>();
  for (const record of records) {
    const pr = record.subject?.pull_request_number;
    if (
      record.signal === "event" &&
      record.name === "score.repair.wave" &&
      pr !== undefined &&
      record.attributes?.dry_run !== true
    ) {
      versionByPullRequest.set(pr, String(record.attributes?.prompt_version ?? "none"));
    }
  }
  const dispatchesByBriefing: Record<string, number> = {};
  // A finding record is appended before the ledger that remembers the thread
  // is persisted; a daemon death in between re-emits it on restart.
  const seenFindings = new Set<string>();
  const tally = (version: string): Tally => {
    let entry = tallies.get(version);
    if (!entry) {
      entry = {
        promptVersion: version,
        pullRequests: new Set(),
        waves: 0,
        findings: 0,
        lateFindings: 0,
        lateRegressions: 0,
        parkedByRule: new Map(),
        merged: new Set(),
        openAtMerge: 0,
      };
      tallies.set(version, entry);
    }
    return entry;
  };
  for (const record of records) {
    if (record.signal !== "event") continue;
    const attributes = record.attributes ?? {};
    // A dry-run pass observes findings and reports what it would send; no
    // wave reached an agent, so none of it is loop behavior to measure.
    if (attributes.dry_run === true) continue;
    const pr = record.subject?.pull_request_number;
    if (record.name === "score.dispatch.decision" && attributes.decision === "started") {
      const version = String(attributes.briefing_version ?? "none");
      dispatchesByBriefing[version] = (dispatchesByBriefing[version] ?? 0) + 1;
      continue;
    }
    if (pr === undefined) continue;
    const entry = tally(versionByPullRequest.get(pr) ?? "none");
    if (record.name === "score.repair.wave") {
      entry.pullRequests.add(pr);
      entry.waves += 1;
      continue;
    }
    if (record.name === "score.repair.finding") {
      const identity = `${pr}:${String(attributes.thread_id ?? "")}`;
      if (attributes.thread_id !== undefined && seenFindings.has(identity)) continue;
      seenFindings.add(identity);
      entry.pullRequests.add(pr);
      entry.findings += 1;
      if (Number(attributes.wave ?? 0) >= 1) {
        entry.lateFindings += 1;
        if (LATE_REGRESSION_CLASSES.has(String(attributes.class))) entry.lateRegressions += 1;
      }
    } else if (record.name === "score.repair.parked") {
      // A park or a merge counts its PR too: under a `since` cutoff the
      // waves that preceded it may lie outside the window, and a segment
      // must not report a merged PR against a denominator of zero.
      entry.pullRequests.add(pr);
      const rule = String(attributes.rule ?? "unknown");
      const parked = entry.parkedByRule.get(rule) ?? new Set<number>();
      parked.add(pr);
      entry.parkedByRule.set(rule, parked);
    } else if (record.name === "score.repair.open_at_merge") {
      entry.pullRequests.add(pr);
      entry.merged.add(pr);
      entry.openAtMerge += Number(attributes.open_findings ?? 0);
    }
  }
  return {
    segments: [...tallies.values()].map((entry) => ({
      promptVersion: entry.promptVersion,
      pullRequests: entry.pullRequests.size,
      waves: entry.waves,
      findings: entry.findings,
      lateFindings: entry.lateFindings,
      lateRegressions: entry.lateRegressions,
      parkedByRule: Object.fromEntries(
        [...entry.parkedByRule].map(([rule, parked]) => [rule, parked.size]),
      ),
      mergedPullRequests: entry.merged.size,
      openAtMerge: entry.openAtMerge,
    })),
    dispatchesByBriefing,
  };
}

/** The baseline table's rows, for the script and the UI. */
export function renderReviewLoopMetrics(metrics: ReviewLoopMetrics): readonly string[] {
  const lines = [
    "prompt_version  PRs  waves/PR  findings  late-share  late-regression-share  merged  open-at-merge  parked",
  ];
  for (const s of metrics.segments) {
    const pct = (a: number, b: number) => (b === 0 ? "-" : `${Math.round((100 * a) / b)}%`);
    const parked = Object.entries(s.parkedByRule)
      .map(([rule, n]) => `${rule}=${n}`)
      .join(",");
    lines.push(
      `${s.promptVersion.padEnd(14)}  ${String(s.pullRequests).padStart(3)}  ${(s.pullRequests ? s.waves / s.pullRequests : 0).toFixed(2).padStart(8)}  ${String(s.findings).padStart(8)}  ${pct(s.lateFindings, s.findings).padStart(10)}  ${pct(s.lateRegressions, s.lateFindings).padStart(21)}  ${String(s.mergedPullRequests).padStart(6)}  ${String(s.openAtMerge).padStart(13)}  ${parked || "-"}`,
    );
  }
  lines.push(
    `dispatches by briefing version: ${
      Object.entries(metrics.dispatchesByBriefing)
        .map(([v, n]) => `${v}=${n}`)
        .join(", ") || "none"
    }`,
  );
  return lines;
}
