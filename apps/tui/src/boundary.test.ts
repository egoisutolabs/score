import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { expect, it } from "vitest";

/** The dependency gate from issue 7: OpenTUI is confined to the tui app. */
it("no @opentui import outside apps/tui", async () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const offenders: string[] = [];
  for (const top of ["apps", "packages"]) {
    for (const entry of await readdir(join(repoRoot, top), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const path = join(entry.parentPath, entry.name);
      if (path.includes(`${sep}node_modules${sep}`)) continue;
      if (path.includes(join("apps", "tui"))) continue;
      if ((await readFile(path, "utf8")).includes("@opentui")) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});

it("TUI read models come through the server API, never project files", async () => {
  const offenders: string[] = [];
  for (const entry of await readdir(import.meta.dirname, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name === "actions.ts"
    ) {
      continue;
    }
    const source = await readFile(join(import.meta.dirname, entry.name), "utf8");
    if (
      source.includes('from "node:fs') ||
      source.includes("@score/shared/config/load") ||
      source.includes("@score/shared/config/layout")
    ) {
      offenders.push(entry.name);
    }
  }
  expect(offenders).toEqual([]);
});
