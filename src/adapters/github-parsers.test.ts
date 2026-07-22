import { expect, test } from "vitest";

import {
  parseGithubIssue,
  parseGithubPullRequest,
  parseUnresolvedThreadCount,
} from "@/adapters/github-parsers";

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

test("missing review-thread connection is empty but malformed non-null evidence throws", () => {
  expect(parseUnresolvedThreadCount({ data: { repository: { pullRequest: null } } })).toBe(0);
  expect(() =>
    parseUnresolvedThreadCount({
      data: { repository: { pullRequest: { reviewThreads: { nodes: "bad" } } } },
    }),
  ).toThrow("nodes must be an array");
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
  ).toEqual([{ status: "MAYBE", conclusion: undefined }]);
});
