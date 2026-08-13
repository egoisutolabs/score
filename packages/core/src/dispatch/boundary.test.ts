import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { expect, it } from "vitest";

/**
 * The identity gate from issue #40: every issue session/branch shape derives
 * from dispatch.identity.ts. One regex catches the ways a shape literal is
 * written in source — a template (`issue-${`), a regex (`issue-\d`), a
 * concrete name (`issue-12`), or a repair suffix template (`issue-%N`).
 */
const SHAPE_LITERAL = /issue-(\d|\\d|\$\{|%N)/;

it("the shape regex catches a reintroduced literal", () => {
  expect(SHAPE_LITERAL.test("const prefix = `issue-${issueNumber}-`;")).toBe(true);
  expect(SHAPE_LITERAL.test("/^issue-\\d+-/.test(branch)")).toBe(true);
  expect(SHAPE_LITERAL.test('"score-demo-issue-%N"')).toBe(true);
  expect(SHAPE_LITERAL.test('session === "issue-12"')).toBe(true);
  expect(SHAPE_LITERAL.test("issueBranchPrefix(issueNumber)")).toBe(false);
});

it("no issue-shape literal outside dispatch.identity.ts", async () => {
  const packagesRoot = join(import.meta.dirname, "..", "..", "..");
  const offenders: string[] = [];
  for (const entry of await readdir(packagesRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name === "dispatch.identity.ts") continue;
    const path = join(entry.parentPath, entry.name);
    if (path.includes(`${sep}node_modules${sep}`)) continue;
    if (!path.includes(`${sep}src${sep}`)) continue;
    if (SHAPE_LITERAL.test(await readFile(path, "utf8"))) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
