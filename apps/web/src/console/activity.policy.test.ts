import { expect, test } from "vitest";
import type { DecisionEvent } from "./activity.policy";
import {
  feedRows,
  foldProject,
  mergesPerDay,
  openPrs,
  TROUBLE_RANK,
  tiles,
} from "./activity.policy";

const PROJECT = "alpha";

function landing(pr: number, tag: string, ts: string, dryRun = false): DecisionEvent {
  return {
    project: PROJECT,
    ts,
    name: "score.landing.decision",
    subject: { pull_request_number: pr },
    attributes: { tag, ...(dryRun && { dry_run: true }) },
  };
}

function repair(pr: number, action: string, ts: string, dryRun = false): DecisionEvent {
  return {
    project: PROJECT,
    ts,
    name: "score.repair.decision",
    subject: { pull_request_number: pr },
    attributes: { action, ...(dryRun && { dry_run: true }) },
  };
}

function dispatch(
  issue: number,
  decision: string,
  ts: string,
  opts: { reason?: string; dryRun?: boolean } = {},
): DecisionEvent {
  return {
    project: PROJECT,
    ts,
    name: "score.dispatch.decision",
    subject: { issue_number: issue },
    attributes: {
      decision,
      ...(opts.reason !== undefined && { reason: opts.reason }),
      ...(opts.dryRun === true && { dry_run: true }),
    },
  };
}

function cleanup(
  ts: string,
  action: string,
  opts: { session?: string; body?: string } = {},
): DecisionEvent {
  return {
    project: PROJECT,
    ts,
    name: "score.cleanup.decision",
    ...(opts.session !== undefined && { subject: { session: opts.session } }),
    attributes: { action },
    ...(opts.body !== undefined && { body: opts.body }),
  };
}

const T = "2026-08-16T10:00:00Z";

test("TROUBLE_RANK runs push-failed first to skipped last", () => {
  expect(TROUBLE_RANK[0]).toBe("push-failed");
  expect(TROUBLE_RANK[TROUBLE_RANK.length - 1]).toBe("skipped");
  expect(TROUBLE_RANK.indexOf("unresolved")).toBeLessThan(TROUBLE_RANK.indexOf("checks-pending"));
});

test("fold keeps the latest state per subject, later array entry winning a ts tie", () => {
  const fold = foldProject(
    [
      landing(7, "conflict", "2026-08-16T10:00:00Z"),
      landing(7, "ready", "2026-08-16T09:00:00Z"),
      landing(7, "soaking", "2026-08-16T10:00:00Z"),
      repair(7, "PINGED", "2026-08-16T09:00:00Z"),
      repair(7, "SPAWNED", "2026-08-16T09:30:00Z"),
      dispatch(12, "blocked", "2026-08-16T09:00:00Z", { reason: "DEPENDENCY_INCOMPLETE" }),
      dispatch(12, "started", "2026-08-16T09:05:00Z"),
    ],
    PROJECT,
  );
  expect(fold.prs.get(7)).toEqual({
    landing: { tag: "soaking", ts: "2026-08-16T10:00:00Z" },
    repair: { action: "SPAWNED", ts: "2026-08-16T09:30:00Z" },
  });
  expect(fold.issues.get(12)).toEqual({ decision: "started", ts: "2026-08-16T09:05:00Z" });
});

test("fold ignores other projects and unknown-suffixed names", () => {
  const fold = foldProject(
    [
      { ...landing(7, "ready", T), project: "beta" },
      {
        project: PROJECT,
        ts: T,
        name: "score.landing.unknown",
        subject: { pull_request_number: 7 },
        attributes: { tag: "weird" },
      },
    ],
    PROJECT,
  );
  expect(fold.prs.size).toBe(0);
});

test("dry-run events never enter the fold", () => {
  const fold = foldProject(
    [
      landing(7, "ready", "2026-08-16T10:00:00Z"),
      landing(7, "conflict", "2026-08-16T11:00:00Z", true),
    ],
    PROJECT,
  );
  expect(fold.prs.get(7)?.landing?.tag).toBe("ready");
});

test("openPrs sorts most-troubled-first, PR number desc on ties, unknown tags last", () => {
  const fold = foldProject(
    [
      landing(1, "soaking", T),
      landing(2, "push-failed", T),
      landing(3, "checks-red", T),
      landing(4, "soaking", T),
      landing(5, "some-future-tag", T),
    ],
    PROJECT,
  );
  expect(openPrs(fold).map((card) => card.number)).toEqual([2, 3, 4, 1, 5]);
});

test("merged PRs drop out of openPrs and only active repair actions ride along", () => {
  const fold = foldProject(
    [
      landing(1, "merged", T),
      landing(2, "unresolved", T),
      repair(2, "SPAWNED", T),
      landing(3, "ready", T),
      repair(3, "NOT_NEEDED", T),
    ],
    PROJECT,
  );
  const cards = openPrs(fold);
  expect(cards.map((card) => card.number)).toEqual([2, 3]);
  expect(cards[0]?.repair).toEqual({ action: "SPAWNED", ts: T });
  expect(cards[1]?.repair).toBeUndefined();
});

test("tiles counts open, stuck at the unresolved boundary, blocked, and 24h merges", () => {
  const now = Date.parse("2026-08-16T12:00:00Z");
  const result = tiles(
    [
      landing(1, "unresolved", T),
      landing(2, "checks-pending", T),
      landing(3, "push-failed", T),
      landing(4, "merged", "2026-08-16T06:00:00Z"),
      dispatch(5, "blocked", T, { reason: "DEPENDENCY_INCOMPLETE" }),
      dispatch(6, "started", T),
    ],
    PROJECT,
    now,
  );
  expect(result).toEqual({ prsOpen: 3, stuck: 2, merged24h: 1, issuesBlocked: 1 });
});

test("merged24h window is (now-24h, now]: the exact-24h event falls out", () => {
  const now = Date.parse("2026-08-16T12:00:00Z");
  const result = tiles(
    [
      landing(1, "merged", "2026-08-15T12:00:00Z"),
      landing(2, "merged", "2026-08-15T12:00:01Z"),
      landing(3, "merged", "2026-08-16T12:00:00Z"),
      landing(4, "merged", "2026-08-16T12:00:01Z"),
    ],
    PROJECT,
    now,
  );
  expect(result.merged24h).toBe(2);
});

test("a dry-run pass leaves every tile untouched", () => {
  const now = Date.parse("2026-08-16T12:00:00Z");
  const result = tiles(
    [
      landing(1, "conflict", "2026-08-16T11:00:00Z", true),
      landing(2, "merged", "2026-08-16T11:00:00Z", true),
      dispatch(3, "blocked", "2026-08-16T11:00:00Z", {
        reason: "ALREADY_IN_FLIGHT",
        dryRun: true,
      }),
    ],
    PROJECT,
    now,
  );
  expect(result).toEqual({ prsOpen: 0, stuck: 0, merged24h: 0, issuesBlocked: 0 });
});

test("mergesPerDay zero-fills UTC day buckets across a month boundary", () => {
  const now = Date.parse("2026-03-02T05:00:00Z");
  const result = mergesPerDay(
    [
      landing(1, "merged", "2026-02-28T23:59:59Z"),
      landing(2, "merged", "2026-03-01T00:00:00Z"),
      landing(3, "merged", "2026-03-02T01:00:00Z"),
      landing(4, "merged", "2026-03-02T02:00:00Z", true),
      landing(5, "soaking", "2026-03-02T01:00:00Z"),
    ],
    PROJECT,
    4,
    now,
  );
  expect(result).toEqual([
    { day: "2026-02-27", count: 0 },
    { day: "2026-02-28", count: 1 },
    { day: "2026-03-01", count: 1 },
    { day: "2026-03-02", count: 1 },
  ]);
});

test("feedRows renders each phase's terse line, newest first, capped at limit", () => {
  const events = [
    dispatch(12, "blocked", "2026-08-16T10:00:01Z", { reason: "DEPENDENCY_INCOMPLETE" }),
    landing(218, "soaking", "2026-08-16T10:00:02Z"),
    repair(221, "PINGED", "2026-08-16T10:00:03Z"),
    cleanup("2026-08-16T10:00:04Z", "STRANDED_RECLAIMED", {
      session: "wt-42",
      body: "worktree reclaimed after ping timeout",
    }),
    dispatch(9, "started", "2026-08-16T10:00:05Z"),
  ];
  expect(feedRows(events, PROJECT, 10)).toEqual([
    { ts: "2026-08-16T10:00:05Z", kind: "dispatch", text: "issue 9 started" },
    {
      ts: "2026-08-16T10:00:04Z",
      kind: "cleanup",
      text: "wt-42 reclaimed — worktree reclaimed after ping timeout",
    },
    { ts: "2026-08-16T10:00:03Z", kind: "repair", text: "#221 pinged" },
    { ts: "2026-08-16T10:00:02Z", kind: "soaking", text: "#218 soaking" },
    {
      ts: "2026-08-16T10:00:01Z",
      kind: "blocked",
      text: "issue 12 blocked — DEPENDENCY_INCOMPLETE",
    },
  ]);
  expect(feedRows(events, PROJECT, 2).map((row) => row.ts)).toEqual([
    "2026-08-16T10:00:05Z",
    "2026-08-16T10:00:04Z",
  ]);
});

test("feedRows drops dry-run events and other projects", () => {
  const rows = feedRows(
    [landing(1, "merged", T, true), { ...landing(2, "ready", T), project: "beta" }],
    PROJECT,
    10,
  );
  expect(rows).toEqual([]);
});
