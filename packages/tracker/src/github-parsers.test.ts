import {
  parseGithubIssue,
  parseGithubPullRequest,
  parseUnresolvedThreadPage,
} from "@score/tracker/github-parsers";
import { expect, test } from "vitest";

test("GitHub issue parser normalizes provider JSON into interfaces", () => {
  const issue = parseGithubIssue({
    number: 1,
    title: "Port models",
    body: null,
    labels: [{ name: "epic:v0", color: "ffffff" }],
    state: "OPEN",
    stateReason: null,
    url: "https://github.com/example/score/issues/1",
    comments: [{ author: { login: "operator" }, body: "keep it small" }],
    ignoredProviderField: true,
  });

  expect(issue.body).toBe("");
  expect(issue.labels).toEqual([{ name: "epic:v0" }]);
  expect(issue.comments[0]?.author?.login).toBe("operator");
});

test("gh's empty-string stateReason on open issues reads as no reason, not an enum error", () => {
  const issue = parseGithubIssue({
    number: 2,
    title: "Open issue",
    body: "",
    labels: [],
    state: "OPEN",
    stateReason: "",
    url: "https://github.com/example/score/issues/2",
  });
  expect(issue.stateReason).toBeNull();
  expect(() =>
    parseGithubIssue({
      number: 2,
      title: "Bad reason",
      body: "",
      labels: [],
      state: "CLOSED",
      stateReason: "MAYBE",
      url: "https://github.com/example/score/issues/2",
    }),
  ).toThrow("github.issue.stateReason must be one of");
});

test("missing review-thread connection is empty but malformed non-null evidence throws", () => {
  expect(parseUnresolvedThreadPage({ data: { repository: { pullRequest: null } } })).toEqual({
    unresolved: 0,
    endCursor: null,
  });
  expect(() =>
    parseUnresolvedThreadPage({
      data: { repository: { pullRequest: { reviewThreads: { nodes: "bad" } } } },
    }),
  ).toThrow("nodes must be an array");
});

test("a truncated review-thread page surfaces its cursor; a cursorless truncation throws", () => {
  const page = (pageInfo: unknown) => ({
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo, nodes: [{ isResolved: false }] } },
      },
    },
  });
  expect(parseUnresolvedThreadPage(page({ hasNextPage: true, endCursor: "C1" }))).toEqual({
    unresolved: 1,
    endCursor: "C1",
  });
  expect(parseUnresolvedThreadPage(page({ hasNextPage: false, endCursor: "C1" }))).toEqual({
    unresolved: 1,
    endCursor: null,
  });
  expect(() => parseUnresolvedThreadPage(page({ hasNextPage: true, endCursor: null }))).toThrow(
    "endCursor",
  );
});

test("GitHub pull-request parser preserves typed check variants", () => {
  const change = parseGithubPullRequest({
    number: 4,
    title: "Safe port",
    headRefName: "issue-1-safe-port",
    headRefOid: "head",
    baseRefOid: "base",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      { status: "COMPLETED", conclusion: "SUCCESS", name: "test" },
      { state: "PENDING", context: "deploy" },
    ],
  });

  expect(change.statusCheckRollup).toEqual([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { state: "PENDING" },
  ]);
});

test("gh's empty-string form of null reads as absent across PR fields", () => {
  const change = parseGithubPullRequest({
    number: 11,
    title: "No decision yet",
    headRefName: "issue-2-daemon-project-mode",
    reviewDecision: "",
    mergedAt: "",
    statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }],
  });
  expect(change.reviewDecision).toBeNull();
  expect(change.mergedAt).toBeNull();
  expect(change.statusCheckRollup).toEqual([{ status: "IN_PROGRESS", conclusion: null }]);
});

test("GitHub parsers reject malformed shapes but preserve provider enum additions", () => {
  expect(() =>
    parseGithubIssue({
      number: 1,
      title: "Bad body",
      body: 42,
      labels: [],
      state: "OPEN",
      url: "https://github.com/example/score/issues/1",
    }),
  ).toThrow("github.issue.body must be a string");
  expect(
    parseGithubPullRequest({
      number: 4,
      title: "Unknown check",
      headRefName: "issue-1-unknown-check",
      statusCheckRollup: [{ status: "MAYBE" }],
    }).statusCheckRollup,
  ).toEqual([{ status: "MAYBE", conclusion: null }]);
});
