import {
  isOpenChildIssue,
  isOwnedIssueWorktree,
  parseDependencies,
} from "@score/core/dispatch/dispatch.policy";
import { describe, expect, test } from "vitest";
import type { IssueObservation } from "./issue.interface";

const policy = {
  eligibleLabelPrefix: "epic:",
  holdLabel: "hold",
  umbrellaLabel: "umbrella",
  triageLabel: "triage",
};

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

  test("triage-labeled issues are ineligible even when the eligible prefix is triage", () => {
    expect(isOpenChildIssue(issue("", ["triage", "epic:v0"]), policy)).toBe(false);
    expect(
      isOpenChildIssue(issue("", ["triage"]), { ...policy, eligibleLabelPrefix: "triage" }),
    ).toBe(false);
  });

  test("excluded labels match case-insensitively, as GitHub resolves them", () => {
    expect(isOpenChildIssue(issue("", ["Triage", "epic:v0"]), policy)).toBe(false);
    expect(isOpenChildIssue(issue("", ["HOLD", "epic:v0"]), policy)).toBe(false);
    expect(isOpenChildIssue(issue("", ["Umbrella", "epic:v0"]), policy)).toBe(false);
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
