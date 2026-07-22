import { expect, test } from "vitest";

import { changedPathsFromPorcelain, cleanupStatusIsSafe } from "@/features/cleanup/policy";

test("cleanup accepts only explicit harness-owned paths", () => {
  const allowlist = ["TASK.md", ".agents/"];
  expect(cleanupStatusIsSafe("?? TASK.md\n M .agents/state.json\n", allowlist)).toBe(true);
  expect(cleanupStatusIsSafe("?? TASK.md\n M src/app.ts\n", allowlist)).toBe(false);
});

test("rename text is preserved exactly like legacy porcelain handling", () => {
  expect(changedPathsFromPorcelain("R  TASK.md -> src/TASK.md\n")).toEqual([
    "TASK.md -> src/TASK.md",
  ]);
  expect(cleanupStatusIsSafe("R  TASK.md -> src/TASK.md\n", ["TASK.md"])).toBe(false);
});
