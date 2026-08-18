import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { expect, it } from "vitest";

/** Ink is the only terminal renderer; the removed native runtime must stay gone. */
it("no removed terminal-renderer import remains", async () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const offenders: string[] = [];
  const removedPackage = ["@open", "tui"].join("");
  for (const top of ["apps", "packages"]) {
    for (const entry of await readdir(join(repoRoot, top), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile() || (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")))
        continue;
      const path = join(entry.parentPath, entry.name);
      if (path.includes(`${sep}node_modules${sep}`)) continue;
      if ((await readFile(path, "utf8")).includes(removedPackage)) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});

it("TUI read models come through the server API, never project files", async () => {
  const offenders: string[] = [];
  for (const entry of await readdir(import.meta.dirname, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) ||
      entry.name.endsWith(".test.ts") ||
      entry.name === "actions.ts"
    ) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const source = await readFile(path, "utf8");
    if (
      source.includes('from "node:fs') ||
      source.includes("@score/shared/config/load") ||
      source.includes("@score/shared/config/layout")
    ) {
      offenders.push(path.slice(import.meta.dirname.length + 1));
    }
  }
  expect(offenders).toEqual([]);
});
