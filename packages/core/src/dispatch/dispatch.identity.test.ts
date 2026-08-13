import {
  createWorkIdentity,
  isIssueBranch,
  issueBranchPrefix,
  issueSessionSuffixPattern,
  repairSessionName,
  sessionNameForIssue,
} from "@score/core/dispatch/dispatch.identity";
import {
  DEFAULT_SESSION_SUFFIX,
  sessionSuffixForNamespace,
} from "@score/core/repair/repair.policy";
import { expect, test } from "vitest";
import type { IssueObservation } from "./issue.interface";

const issue: IssueObservation = {
  number: 12,
  title: "Fleet supervisor",
  body: "",
  labels: [],
  state: "OPEN",
  url: "https://github.com/example/score/issues/12",
  comments: [],
};

test("bare identity keeps today's names byte-for-byte", () => {
  expect(createWorkIdentity("/wt", issue)).toEqual({
    issueNumber: 12,
    branch: "issue-12-fleet-supervisor",
    worktreePath: "/wt/issue-12-fleet-supervisor",
    sessionName: "issue-12",
  });
  expect(sessionNameForIssue(undefined, 12)).toBe("issue-12");
  expect(repairSessionName(undefined, 12)).toBe("shepherd-pr-12");
});

test("namespaced identity carries the fleet prefix and project key", () => {
  const identity = createWorkIdentity("/wt", issue, "score");
  expect(identity.sessionName).toBe("score-score-issue-12");
  // Branches live per-repo, so they stay un-namespaced.
  expect(identity.branch).toBe("issue-12-fleet-supervisor");
  expect(identity.worktreePath).toBe("/wt/issue-12-fleet-supervisor");
  expect(repairSessionName("score", 12)).toBe("score-score-shepherd-pr-12");
});

test("every valid project key yields tmux-valid session names", () => {
  // The full key charset from config load (PROJECT_KEY_PATTERN, [a-z0-9-]).
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
  for (const character of alphabet) {
    for (const key of [character, `a${character}`, `${character}-9z`]) {
      expect(key).toMatch(/^[a-z0-9-]+$/);
      for (const name of [sessionNameForIssue(key, 12), repairSessionName(key, 12)]) {
        // ":" and "." address windows/panes in tmux targets — never in a name.
        expect(name).not.toContain(":");
        expect(name).not.toContain(".");
      }
    }
  }
});

test("issueBranchPrefix reproduces the in-flight probe's literal byte-for-byte", () => {
  expect(issueBranchPrefix(12)).toBe("issue-12-");
  expect(createWorkIdentity("/wt", issue).branch.startsWith(issueBranchPrefix(12))).toBe(true);
});

test("isIssueBranch accepts and rejects exactly what /^issue-\\d+-/ did", () => {
  expect(isIssueBranch("issue-12-fleet-supervisor")).toBe(true);
  expect(isIssueBranch("issue-1-x")).toBe(true);
  // Prefix-only, non-numeric, unanchored, and missing-dash shapes all miss.
  expect(isIssueBranch("issue-12")).toBe(false);
  expect(isIssueBranch("issue-")).toBe(false);
  expect(isIssueBranch("issue-abc-thing")).toBe(false);
  expect(isIssueBranch("my-issue-1-x")).toBe(false);
  expect(isIssueBranch("score-demo-issue-12-x")).toBe(false);
  expect(isIssueBranch("")).toBe(false);
});

test("session suffix templates keep today's values byte-for-byte", () => {
  // The legacy unmanaged quirk pinned exactly (see issueSessionSuffixPattern).
  expect(issueSessionSuffixPattern(undefined)).toBe("^issue-%N");
  expect(issueSessionSuffixPattern("demo")).toBe("^score-demo-issue-%N");
  expect(sessionSuffixForNamespace(undefined)).toBe("^issue-%N");
  expect(sessionSuffixForNamespace("demo")).toBe("^score-demo-issue-%N");
});

test("repair's namespaced suffix matches exactly its own dispatch sessions", () => {
  const pattern = new RegExp(`${sessionSuffixForNamespace("demo").replace("%N", "12")}$`);
  expect(pattern.test(sessionNameForIssue("demo", 12))).toBe(true);
  expect(pattern.test(sessionNameForIssue("other", 12))).toBe(false);
  expect(pattern.test(sessionNameForIssue(undefined, 12))).toBe(false);
  expect(sessionSuffixForNamespace(undefined)).toBe(DEFAULT_SESSION_SUFFIX);
});
