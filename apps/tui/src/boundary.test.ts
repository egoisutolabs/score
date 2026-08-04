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
