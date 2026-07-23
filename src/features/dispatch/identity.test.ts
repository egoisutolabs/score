import { expect, test } from "vitest";

import {
  createWorkIdentity,
  repairSessionName,
  sessionNameForIssue,
} from "@/features/dispatch/identity";
import type { IssueObservation } from "@/features/dispatch/issue";
import { DEFAULT_SESSION_SUFFIX, sessionSuffixForNamespace } from "@/features/repair/policy";

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

test("repair's namespaced suffix matches exactly its own dispatch sessions", () => {
  const pattern = new RegExp(`${sessionSuffixForNamespace("demo").replace("%N", "12")}$`);
  expect(pattern.test(sessionNameForIssue("demo", 12))).toBe(true);
  expect(pattern.test(sessionNameForIssue("other", 12))).toBe(false);
  expect(pattern.test(sessionNameForIssue(undefined, 12))).toBe(false);
  expect(sessionSuffixForNamespace(undefined)).toBe(DEFAULT_SESSION_SUFFIX);
});
