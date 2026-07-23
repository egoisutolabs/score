import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { createFileLogger } from "@/shared/file-log";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "score-file-log-"));
  sandboxes.push(path);
  return path;
}

test("lines land in today's dated file, plain and debug-gated like the console logger", async () => {
  const dir = await sandbox();
  const log = createFileLogger(dir, false, () => new Date("2026-07-23T12:00:00Z"));
  log.info("daemon started");
  log.debug("hidden without --verbose");
  log.lines([{ level: "warn", text: "phase landing failed" }]);

  const content = await readFile(join(dir, "2026-07-23.log"), "utf8");
  expect(content).toBe(
    "[2026-07-23T12:00:00.000Z] [info] daemon started\n" +
      "[2026-07-23T12:00:00.000Z] [warn] phase landing failed\n",
  );
  // No ANSI escapes ever — the sink is a file, not a TTY.
  expect(content).not.toContain("\x1b[");
});

test("retention sweeps strictly-older files on enable and keeps the boundary day", async () => {
  const dir = await sandbox();
  await writeFile(join(dir, "2026-06-22.log"), "31 days old\n");
  await writeFile(join(dir, "2026-06-23.log"), "exactly 30 days old\n");
  await writeFile(join(dir, "2026-06-24.log"), "29 days old\n");
  await writeFile(join(dir, "notes.txt"), "not a dated log\n");

  const log = createFileLogger(dir, false, () => new Date("2026-07-23T12:00:00Z"));
  log.enableRetention(30);

  expect(existsSync(join(dir, "2026-06-22.log"))).toBe(false);
  expect(existsSync(join(dir, "2026-06-23.log"))).toBe(true);
  expect(existsSync(join(dir, "2026-06-24.log"))).toBe(true);
  expect(existsSync(join(dir, "notes.txt"))).toBe(true);
});

test("midnight roll opens the new dated file without dropping lines and re-sweeps", async () => {
  const dir = await sandbox();
  await writeFile(join(dir, "2026-06-23.log"), "old\n");
  let now = new Date("2026-07-23T23:59:59Z");
  const log = createFileLogger(dir, false, () => now);
  log.enableRetention(30);
  expect(existsSync(join(dir, "2026-06-23.log"))).toBe(true);

  log.info("before midnight");
  now = new Date("2026-07-24T00:00:01Z");
  log.info("after midnight");

  expect(await readFile(join(dir, "2026-07-23.log"), "utf8")).toContain("before midnight");
  expect(await readFile(join(dir, "2026-07-24.log"), "utf8")).toContain("after midnight");
  // The roll re-ran the sweep: 2026-06-23 is now 31 days old.
  expect(existsSync(join(dir, "2026-06-23.log"))).toBe(false);
});
