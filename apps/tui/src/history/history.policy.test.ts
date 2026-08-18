import { describe, expect, it } from "vitest";
import type { GitHubMerge, HistoryEvent } from "./history.interface";
import { historyOverview } from "./history.policy";

const landing = (
  project: string,
  pullRequest: number,
  ts: string,
  dryRun = false,
): HistoryEvent => ({
  project,
  ts,
  name: "score.landing.decision",
  subject: { pull_request_number: pullRequest },
  attributes: { tag: "merged", dry_run: dryRun },
});

const merge = (project: string, pullRequest: number, mergedTs: string): GitHubMerge => ({
  project,
  pullRequest,
  title: `Merge ${pullRequest}`,
  mergedTs,
});

describe("history overview", () => {
  it("builds exact UTC calendar buckets for the selected range", () => {
    const overview = historyOverview(
      [
        landing("alpha", 1, "2026-08-10T23:59:59.000Z"),
        landing("alpha", 2, "2026-08-11T00:00:00.000Z"),
        landing("alpha", 3, "2026-08-17T23:59:59.000Z"),
        landing("alpha", 4, "2026-08-17T12:00:00.000Z", true),
      ],
      ["alpha"],
      "2026-08-17",
      7,
    );

    expect(overview.startDay).toBe("2026-08-11");
    expect(overview.merged).toBe(2);
    expect(overview.mergesByDay).toHaveLength(7);
    expect(overview.mergesByDay[0]).toBe(1);
    expect(overview.mergesByDay[6]).toBe(1);
    expect(overview.busiestDay).toBe(1);
  });

  it("uses GitHub facts and de-duplicates matching daemon evidence", () => {
    const overview = historyOverview(
      [landing("alpha", 103, "2026-08-17T10:00:00.000Z")],
      ["alpha"],
      "2026-08-17",
      30,
      [merge("alpha", 103, "2026-08-17T10:00:05.000Z")],
    );

    expect(overview.merged).toBe(1);
    expect(overview.recent[0]).toMatchObject({
      pullRequest: 103,
      title: "Merge 103",
      mergedTs: "2026-08-17T10:00:05.000Z",
    });
  });

  it("summarizes project share, activity, latest merge, and ordering", () => {
    const overview = historyOverview([], ["idle", "beta", "alpha"], "2026-08-17", 30, [
      merge("alpha", 1, "2026-08-16T10:00:00.000Z"),
      merge("alpha", 2, "2026-08-17T10:00:00.000Z"),
      merge("beta", 3, "2026-08-15T10:00:00.000Z"),
    ]);

    expect(overview.activeProjects).toBe(2);
    expect(overview.latestTs).toBe("2026-08-17T10:00:00.000Z");
    expect(overview.byProject.map((row) => row.project)).toEqual(["alpha", "beta", "idle"]);
    expect(overview.byProject[0]).toMatchObject({
      merged: 2,
      share: 2 / 3,
      latestTs: "2026-08-17T10:00:00.000Z",
    });
  });

  it("keeps a project found only in retained merge evidence", () => {
    const overview = historyOverview([], ["alpha"], "2026-08-17", 7, [
      merge("retired", 7, "2026-08-17T00:05:00.000Z"),
    ]);

    expect(overview.byProject.map((row) => row.project)).toEqual(["retired", "alpha"]);
  });
});
