import {
  countChecks,
  exhaustionMarker,
  REPAIR_EXHAUSTED_LABEL,
  REPAIR_WAVE_STEPS,
  renderExhaustionComment,
  renderRepairPrompt,
} from "@score/core/repair/repair.policy";
import { VERIFY_COMMAND } from "@score/core/verify";
import { expect, test } from "vitest";

// Contract for the repair prompt (review-loop analysis §2.1). Each assertion
// names a behavior the old prompt lacked and the baseline measured the cost of.

test("repair prompt names the seven wave steps in protocol order", () => {
  const prompt = renderRepairPrompt(42);
  const positions = REPAIR_WAVE_STEPS.map((step) => prompt.indexOf(`${step} —`));
  for (const position of positions) expect(position).toBeGreaterThan(-1);
  for (let i = 1; i < positions.length; i += 1) {
    expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1);
  }
});

test("repair prompt stays on one line because tmux ping submits on Enter", () => {
  expect(renderRepairPrompt(42)).not.toContain("\n");
  expect(renderRepairPrompt(42, "make verify: exit 2")).not.toContain("\n");
});

test("repair prompt lets the agent decline a finding and forbids resolving a decline", () => {
  const prompt = renderRepairPrompt(42);
  expect(prompt).toMatch(/mark each FIX or DECLINE with a one-line reason/);
  expect(prompt).toMatch(/never resolve a DECLINE/);
});

test("repair prompt sends new-code findings to fix or decline, never to a triage issue", () => {
  expect(renderRepairPrompt(42)).toMatch(
    /a finding in code this PR added is always FIX or DECLINE, never a triage issue/,
  );
});

test("repair prompt requires a failing test before the fix and verification before the push", () => {
  const prompt = renderRepairPrompt(42);
  expect(prompt).toMatch(/write a test that fails on the current tree, then make it pass/);
  expect(prompt).toContain(
    `run ${VERIFY_COMMAND} at the repository root; do not push while it fails`,
  );
  // Verify must come before the commit-and-push step, or "verify before push" is just words.
  expect(prompt.indexOf("VERIFY —")).toBeLessThan(prompt.indexOf("ONE COMMIT —"));
});

test("repair prompt asks for one commit per wave and a diff sweep for the defect class", () => {
  const prompt = renderRepairPrompt(42);
  expect(prompt).toMatch(/commit the whole wave once and push once/);
  expect(prompt).toMatch(/sweep the full PR diff for every other instance of that class/);
});

test("repair prompt keeps the PR number, CI check, and merge refusal", () => {
  const prompt = renderRepairPrompt(42);
  expect(prompt).toContain("PR #42");
  expect(prompt).toContain("gh pr checks 42");
  expect(prompt).toMatch(/Do NOT merge the PR/);
});

test("repair prompt appends the build-red tail only when landing handed one over", () => {
  const tail = "make verify: tsc exit 2";
  expect(renderRepairPrompt(7, tail)).toMatch(new RegExp(`fix this failure too: ${tail}\\.$`));
  expect(renderRepairPrompt(7)).not.toContain("merged-tree build gate");
});

test("countChecks mirrors landing: running or expected is pending, non-success completion is failing", () => {
  expect(
    countChecks([
      { status: "IN_PROGRESS", conclusion: null },
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "COMPLETED", conclusion: "FAILURE" },
      { state: "PENDING" },
      { state: "EXPECTED" },
      { state: "SUCCESS" },
      { state: "ERROR" },
    ]),
  ).toEqual({ failing: 2, pending: 3 });
  expect(countChecks([])).toEqual({ failing: 0, pending: 0 });
});

test("the exhaustion comment opens with the marker and lists every wave", () => {
  const body = renderExhaustionComment(99, {
    budget: 2,
    rule: "diff-growing",
    detail: "diff grew 10 → 20 → 30 lines over the last three waves",
    waves: [
      {
        at: "2026-10-16T10:00:00Z",
        tick: 4,
        headSha: "abcdef0123",
        defects: { conflicting: true, unresolvedThreads: 3, failingChecks: 0 },
        openFindings: 3,
        diffSize: 120,
        promptVersion: "v1",
      },
      {
        at: "2026-10-16T10:05:00Z",
        tick: 9,
        headSha: undefined,
        defects: { conflicting: false, unresolvedThreads: 0, failingChecks: 1, buildRed: "tsc" },
        openFindings: 4,
        diffSize: undefined,
        promptVersion: "v1",
      },
    ],
  });
  // The marker is scoped to this history: two waves, the last at 10:05.
  expect(body.startsWith("<!-- score:repair-exhausted 2@2026-10-16T10:05:00Z -->\n")).toBe(true);
  expect(exhaustionMarker({ waves: [] })).toBe("<!-- score:repair-exhausted 0@none -->");
  expect(body).toContain("PR #99");
  expect(body).toContain(
    "Rule: diff-growing — diff grew 10 → 20 → 30 lines over the last three waves.",
  );
  expect(body).toContain(
    "| 1 | 2026-10-16T10:00:00Z | abcdef0 | 3 | 120 | conflicts, 3 unresolved thread(s) |",
  );
  expect(body).toContain(
    "| 2 | 2026-10-16T10:05:00Z | unknown | 4 | ? | 1 failing check(s), merged-tree build red |",
  );
  expect(body).toContain(`Remove the \`${REPAIR_EXHAUSTED_LABEL}\` label`);
});
