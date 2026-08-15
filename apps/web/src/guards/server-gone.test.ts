import { execFileSync } from "node:child_process";
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
    // Any member position inside an app brace expansion — `apps/{daemon,`…
    // …`,tui}` lists the stub as live wherever it sits, not just last.
    new RegExp(`apps/\\{(?:[a-z0-9-]+,)*${fragment}(?:,[a-z0-9-]+)*\\}`),
  ];
}

function trackedFiles(): { root: string; paths: string[] } {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  const paths = out.split("\n").filter((line) => line !== "");
  return { root, paths };
}

test("no live reference to the deleted server stub survives", async () => {
  const patterns = serverPatterns();
  const { root, paths } = trackedFiles();
  const offenders: string[] = [];
  for (const path of paths) {
    // The tracked path itself first: a resurrected stub-app file (whatever
    // its contents say) proves the app is back. Contents come from the git
    // blob, not the filesystem: a tracked symlink's resolved target (a
    // dangling link, a directory) is not what git versioned.
    const text = blobText(root, path);
    for (const pattern of patterns) {
      if (pattern.test(path)) offenders.push(path);
      if (pattern.test(text)) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});

/** `HEAD:<path>` — the versioned bytes. Untracked-in-HEAD paths read empty. */
function blobText(root: string, path: string): string {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return ""; // staged but not committed — the path-name check still covers it
  }
}

test("the brace pattern matches the stub at any member position", () => {
  // Sample strings are fragment-assembled like the needle, so this file
  // never carries a live-form reference the scan test above would catch.
  const apps = (expansion: string) => `apps/{${expansion}}`;
  const flagged = [
    apps(NEEDLE),
    apps(`daemon,${NEEDLE}`),
    apps(`daemon,${NEEDLE},tui`),
    apps(`${NEEDLE},daemon,tui`),
  ];
  const brace = serverPatterns()[2];
  if (brace === undefined) throw new Error("brace pattern missing");
  for (const sample of flagged) expect(brace.test(sample), sample).toBe(true);
  for (const clean of [apps("daemon,tui,web"), `apps/${["w", "eb"].join("")}`]) {
    expect(brace.test(clean), clean).toBe(false);
  }
});
