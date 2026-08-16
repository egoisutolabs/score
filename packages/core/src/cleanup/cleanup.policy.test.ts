import {
  autoPullRefusalReason,
  changedPathsFromPorcelain,
  cleanupStatusIsSafe,
} from "@score/core/cleanup/cleanup.policy";
import { expect, test } from "vitest";

test("cleanup accepts only explicit harness-owned paths", () => {
  const allowlist = ["TASK.md", ".agents/"];
  expect(cleanupStatusIsSafe("?? TASK.md\n M .agents/state.json\n", allowlist)).toBe(true);
  expect(cleanupStatusIsSafe("?? TASK.md\n M src/app.ts\n", allowlist)).toBe(false);
});

test("auto-pull refusal names the wrong branch or the blocking paths (#91)", () => {
  expect(autoPullRefusalReason({ branch: "feature", status: "" }, "main")).toBe(
    "primary checkout is on feature, not main",
  );
  expect(
    autoPullRefusalReason(
      { branch: "main", status: "?? apps/web/.next/cache/a\n?? apps/web/.turbo/b\n" },
      "main",
    ),
  ).toBe("primary checkout is not clean: apps/web/.next/cache/a, apps/web/.turbo/b");
  expect(autoPullRefusalReason({ branch: "main", status: "" }, "main")).toBe(
    "fast-forward refused despite a clean primary checkout",
  );
});

test("auto-pull refusal caps the named paths instead of flooding the log (#91)", () => {
  const status = Array.from({ length: 12 }, (_, index) => `?? file-${index}`).join("\n");
  const reason = autoPullRefusalReason({ branch: "main", status }, "main");
  expect(reason).toContain("file-9");
  expect(reason).not.toContain("file-10");
  expect(reason).toContain("(+2 more)");
});

test("rename text is preserved exactly like legacy porcelain handling", () => {
  expect(changedPathsFromPorcelain("R  TASK.md -> src/TASK.md\n")).toEqual([
    "TASK.md -> src/TASK.md",
  ]);
  expect(cleanupStatusIsSafe("R  TASK.md -> src/TASK.md\n", ["TASK.md"])).toBe(false);
});
