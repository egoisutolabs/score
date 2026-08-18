import type { GitHubMergeHistory } from "@score/tracker/github.service";
import { expect, test } from "vitest";
import { type HistoryDependencies, type HistoryProject, HistoryService } from "./history.service";

const SCORE: HistoryProject = {
  key: "score",
  repositoryPath: "/repo/score",
  repository: "acme/score",
};
const MARGIN: HistoryProject = {
  key: "margin",
  repositoryPath: "/repo/margin",
  repository: "acme/margin",
};

function merge(number: number, mergedAt: string): GitHubMergeHistory {
  return { number, title: `Merge ${number}`, headRefName: `feature/${number}`, mergedAt };
}

function dependencies(overrides: Partial<HistoryDependencies> = {}): HistoryDependencies {
  return {
    loadProjects: async () => [SCORE, MARGIN],
    observeMerges: async (project) =>
      project.key === "score"
        ? [merge(103, "2026-08-18T01:25:50Z"), merge(102, "2026-08-16T08:31:22Z")]
        : [merge(9, "2026-08-18T02:00:00Z")],
    now: () => Date.parse("2026-08-18T03:00:00Z"),
    cacheMs: 30_000,
    ...overrides,
  };
}

test("history reads every configured repository and filters by GitHub merge time", async () => {
  const history = new HistoryService(dependencies());
  const outcome = await history.observe(Date.parse("2026-08-18T00:00:00Z"));

  expect(outcome).toEqual({
    kind: "ok",
    merges: [
      {
        project: "margin",
        pull_request_number: 9,
        title: "Merge 9",
        merged_at: "2026-08-18T02:00:00Z",
      },
      {
        project: "score",
        pull_request_number: 103,
        title: "Merge 103",
        merged_at: "2026-08-18T01:25:50Z",
      },
    ],
    warnings: [],
  });
});

test("one unavailable repository degrades explicitly without hiding healthy results", async () => {
  const history = new HistoryService(
    dependencies({
      observeMerges: async (project) => {
        if (project.key === "margin") throw new Error("gh unavailable");
        return [merge(103, "2026-08-18T01:25:50Z")];
      },
    }),
  );

  const outcome = await history.observe(Date.parse("2026-08-18T00:00:00Z"));
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error("expected history");
  expect(outcome.merges).toHaveLength(1);
  expect(outcome.warnings).toEqual([{ reason: "GITHUB_UNAVAILABLE" }]);
});

test("history caches one GitHub observation for the polling interval", async () => {
  let calls = 0;
  const history = new HistoryService(
    dependencies({
      observeMerges: async () => {
        calls += 1;
        return [];
      },
    }),
  );
  const since = Date.parse("2026-08-18T00:00:00Z");

  await history.observe(since);
  await history.observe(since);
  expect(calls).toBe(2);
});

test("an unreadable config fails before any GitHub command", async () => {
  let calls = 0;
  const history = new HistoryService(
    dependencies({
      loadProjects: async () => {
        throw new Error("bad config");
      },
      observeMerges: async () => {
        calls += 1;
        return [];
      },
    }),
  );

  expect(await history.observe(0)).toEqual({
    kind: "error",
    status: 503,
    reason: "CONFIG_UNPARSEABLE",
  });
  expect(calls).toBe(0);
});
