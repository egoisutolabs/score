import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The app serves an operator console successor on a loopback-only contract
// (locked decision #58): every command that can bind must bind 127.0.0.1,
// and nothing may widen it behind a flag.
const appManifest = new URL("../../package.json", import.meta.url);

test("dev and start bind the loopback hostname explicitly", async () => {
  const pkg = JSON.parse(await readFile(fileURLToPath(appManifest), "utf8"));
  for (const script of ["dev", "start"]) {
    expect(pkg.scripts[script], pkg.scripts[script]).toContain("--hostname 127.0.0.1");
  }
});

test("no script offers a broader binding escape hatch", async () => {
  const pkg = JSON.parse(await readFile(fileURLToPath(appManifest), "utf8"));
  expect(JSON.stringify(pkg.scripts)).not.toContain("0.0.0.0");
  // Every hostname flag — long or short form — must be the loopback pin.
  for (const command of Object.values(pkg.scripts as Record<string, string>)) {
    for (const match of command.matchAll(/(?:--hostname|-H)\s+(\S+)/g)) {
      expect(match[1]).toBe("127.0.0.1");
    }
  }
});
