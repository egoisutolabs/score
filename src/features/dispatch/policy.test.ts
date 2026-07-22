import { describe, expect, test } from "vitest";

import type { IssueObservation } from "@/features/dispatch/issue";
import {
  isOpenChildIssue,
  isOwnedIssueWorktree,
  parseDependencies,
} from "@/features/dispatch/policy";

const policy = { eligibleLabelPrefix: "epic:", holdLabel: "hold", umbrellaLabel: "umbrella" };

function issue(body: string, labels = ["epic:v0"]): IssueObservation {
  return {
    number: 1,
    title: "Port the loop",
    body,
    labels: labels.map((name) => ({ name })),
    state: "OPEN",
    url: "https://github.com/example/score/issues/1",
    comments: [],
  };
}

describe("legacy dispatch policy", () => {
  test("parses only dependency bullets inside the Dependencies section", () => {
    const body = `- #99
## Dependencies
- #2 required
text #3
- #4
## Risk
- #5`;
    expect(parseDependencies(body)).toEqual([2, 4]);
  });

  test("candidate scan requires prefix and excludes held and umbrella issues", () => {
    expect(isOpenChildIssue(issue(""), policy)).toBe(true);
    expect(isOpenChildIssue(issue("", ["hold", "epic:v0"]), policy)).toBe(false);
    expect(isOpenChildIssue(issue("", ["umbrella", "epic:v0"]), policy)).toBe(false);
    expect(isOpenChildIssue(issue("", ["bug"]), policy)).toBe(false);
  });

  test("detached issue worktree basename still consumes legacy capacity", () => {
    expect(
      isOwnedIssueWorktree(
        { path: "/worktrees/issue-9-port", branch: "", locked: false },
        "/worktrees",
      ),
    ).toBe(true);
  });
});
