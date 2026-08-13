import type { PullRequestObservation } from "@score/core/landing/change.interface";
import {
  evaluatePreconditions,
  gatesFor,
  listLandingCandidates,
  meaningfulStatusLines,
} from "@score/core/landing/landing.policy";
import { expect, test } from "vitest";

function pullRequest(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    number: 7,
    title: "Safe change",
    headRefName: "issue-1-safe-change",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    labels: [],
    files: [],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

test("drafts, skip labels, and optional non-issue heads are filtered before landing", () => {
  const candidates = listLandingCandidates(
    [
      pullRequest({ number: 1, isDraft: true }),
      pullRequest({ number: 2, labels: [{ name: "WIP" }] }),
      pullRequest({ number: 3, headRefName: "feature/unowned" }),
      pullRequest({ number: 4 }),
    ],
    { skipLabels: ["wip"], onlyIssueBranches: true },
  );
  expect(candidates.map((change) => change.number)).toEqual([4]);
});

test("unknown mergeability passes host preconditions exactly like legacy", () => {
  expect(evaluatePreconditions(pullRequest({ mergeable: "UNKNOWN" }), 0)).toBeNull();
});

test("every PR gets the make-verify root gate, regardless of files", () => {
  const gates = gatesFor("/repo");
  expect(gates).toHaveLength(1);
  expect(gates[0]?.cwd).toBe("/repo");
  expect(gates[0]?.steps[0]?.command).toEqual(["make", "verify"]);
  expect(gates[0]?.steps[0]?.retry).toBe(true);
});

test("meaningful status ignores exactly the scheduler lock path, nothing that resembles it", () => {
  expect(meaningfulStatusLines("?? .claude/scheduled_tasks.lock\n")).toEqual([]);
  expect(meaningfulStatusLines(" M .claude/scheduled_tasks.lock\n")).toEqual([]);
  // Substring lookalikes are operator files; a hard reset must not eat them.
  expect(meaningfulStatusLines("?? docs/.claude/scheduled_tasks.lock\n")).toEqual([
    "?? docs/.claude/scheduled_tasks.lock",
  ]);
  expect(meaningfulStatusLines("?? .claude/scheduled_tasks.lock.backup\n")).toEqual([
    "?? .claude/scheduled_tasks.lock.backup",
  ]);
  expect(meaningfulStatusLines(" M README.md\n?? .claude/scheduled_tasks.lock\n")).toEqual([
    " M README.md",
  ]);
  expect(meaningfulStatusLines("")).toEqual([]);
});
