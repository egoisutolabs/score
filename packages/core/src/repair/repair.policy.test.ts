import { REPAIR_WAVE_STEPS, renderRepairPrompt } from "@score/core/repair/repair.policy";
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
