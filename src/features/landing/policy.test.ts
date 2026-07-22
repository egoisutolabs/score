import { expect, test } from "vitest";

import type { PullRequestObservation } from "@/features/landing/change";
import { evaluatePreconditions, gatesFor, listLandingCandidates } from "@/features/landing/policy";

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

test("legacy touched-area gates preserve order and retry metadata", () => {
  const gates = gatesFor(
    pullRequest({ files: [{ path: "dashboard/app.ts" }, { path: "daemon/worker.ts" }] }),
    "/repo",
  );
  expect(gates.map((gate) => gate.name)).toEqual(["daemon", "dashboard"]);
  expect(gates[0]?.steps[1]?.retry).toBe(true);
});
