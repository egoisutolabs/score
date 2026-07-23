import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

/** The dependency gate from issue 7: OpenTUI is confined to this feature. */
it("no @opentui import outside src/features/tui/", async () => {
  const src = join(import.meta.dirname, "..", "..");
  const offenders: string[] = [];
  for (const entry of await readdir(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.includes(join("features", "tui"))) continue;
    if ((await readFile(path, "utf8")).includes("@opentui")) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
