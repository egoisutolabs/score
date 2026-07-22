import { expect, test } from "vitest";

import { renderLandingTick } from "@/features/landing/render";

test("landing tick renders icon lines, scoreboard, and needs-attention warnings", () => {
  const lines = renderLandingTick([
    { pullRequestNumber: 1, tag: "merged", note: "soak complete (daemon)" },
    { pullRequestNumber: 2, tag: "conflict", note: "git merge hit conflicts (aborted)" },
    {
      pullRequestNumber: 3,
      tag: "conflict",
      note: "needs main pulled / manual conflict resolution",
    },
    { pullRequestNumber: 4, tag: "soaking", note: "green+resolved (daemon); merging in 120s" },
  ]);

  // merged is a real state change → info; conflict/soaking lines exist but at debug.
  const merged = lines.find((line) => line.text.includes("[merged]"));
  expect(merged).toEqual({ level: "info", text: "✓ #1 [merged] soak complete (daemon)" });
  const conflictLine = lines.find((line) => line.text.startsWith("⚠ #2"));
  expect(conflictLine?.level).toBe("debug");
  // Scoreboard is info because the tick was eventful (a merge + attention).
  expect(lines).toContainEqual({ level: "info", text: "tick: merged=1  conflict=2  soaking=1" });
  expect(lines.filter((line) => line.level === "warn").map((line) => line.text)).toEqual([
    "needs attention (conflict): #2 #3",
  ]);
});

test("a quiet tick (only soaking, nothing merged or flagged) prints nothing at info", () => {
  const lines = renderLandingTick([
    { pullRequestNumber: 5, tag: "soaking", note: "green+resolved (daemon); merging next tick" },
    { pullRequestNumber: 6, tag: "checks-pending", note: "1 GitHub check(s) still running" },
  ]);
  expect(lines.filter((line) => line.level === "info")).toEqual([]);
});

test("landing tick with no PRs emits no lines", () => {
  expect(renderLandingTick([])).toEqual([]);
});
