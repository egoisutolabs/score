import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The deleted server stub is gone for good: no reference to it may survive
// in any tracked file — as a bare path (`apps/…/server`), a package name
// (`@score/…`), or a brace expansion (`apps/{daemon,tui,…}`) listing it as an
// entry point. Needles are assembled from fragments so this test file does
// not match itself; "live" means git-tracked — the operator's untracked
// briefing naming what it deletes is not a reference.
const NEEDLE = ["ser", "ver"].join("");

function serverPatterns(): RegExp[] {
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fragment = escapeRegExp(NEEDLE);
  return [
    new RegExp(`@score/${fragment}\\b`),
    new RegExp(`apps/${fragment}\\b`),
    new RegExp(`apps/\\{[a-z,-]*,${fragment}\\}`),
  ];
}

function trackedFiles(): string[] {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `${root}${line}`);
}

test("no live reference to the deleted server stub survives", async () => {
  const patterns = serverPatterns();
  const offenders: string[] = [];
  for (const path of trackedFiles()) {
    const text = await readFile(path, "utf8").catch(() => "");
    for (const pattern of patterns) {
      if (pattern.test(text)) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
