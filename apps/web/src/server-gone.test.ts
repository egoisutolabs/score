import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The deleted server stub is gone for good: no reference to it may survive
// in any tracked file (the acceptance gate is the equivalent repo-wide text
// search returning nothing live). Needles are assembled from fragments so
// this test file does not match itself; "live" means git-tracked — the
// operator's untracked briefing naming what it deletes is not a reference.
const NEEDLES: [string, string][] = [
  ["@score/", "server"],
  ["apps/", "server"],
];

function trackedFiles(): string[] {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `${root}${line}`);
}

test("no live reference to the deleted server stub survives", async () => {
  const offenders: string[] = [];
  for (const path of trackedFiles()) {
    const text = await readFile(path, "utf8").catch(() => "");
    for (const [head, tail] of NEEDLES) {
      if (text.includes(head + tail)) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
