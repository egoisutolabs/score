import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import { gateFailureFrom, StatusWriter } from "@/features/daemon/status";
import type { LandingResult } from "@/features/landing/change";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "score-status-"));
  sandboxes.push(path);
  return path;
}

function landing(tag: LandingResult["tag"], note: string): LandingResult {
  return { pullRequestNumber: 7, tag, note };
}

test("gateFailureFrom carries the latest build-red tail and clears on a green tick", () => {
  expect(gateFailureFrom([landing("merged", "ok"), landing("soaking", "green")])).toBeNull();
  expect(
    gateFailureFrom([
      landing("build-red", "daemon:check — TS2345 first"),
      landing("merged", "ok"),
      landing("build-red", "daemon:test — 2 failed last"),
    ]),
  ).toBe("daemon:test — 2 failed last");
  expect(gateFailureFrom([])).toBeNull();
});

test("writes merge into a full schema snapshot and round-trip as JSON", async () => {
  const path = join(await sandbox(), "status.json");
  const writer = new StatusWriter(path);
  await writer.write({ state: "starting" });
  await writer.write({ state: "running", tick: 3, last_gate_failure: "daemon:check — boom" });

  const parsed = JSON.parse(await readFile(path, "utf8"));
  expect(parsed).toMatchObject({
    state: "running",
    pid: process.pid,
    tick: 3,
    last_pass_started_at: null,
    last_pass_completed_at: null,
    last_error: null,
    last_gate_failure: "daemon:check — boom",
  });
  expect(typeof parsed.updated_at).toBe("string");
});

test("a reader polling during continuous writes never sees a partial file", async () => {
  const path = join(await sandbox(), "status.json");
  const writer = new StatusWriter(path);
  await writer.write({ state: "starting" });

  let parseFailures = 0;
  let reads = 0;
  let done = false;
  const reader = (async () => {
    while (!done) {
      const text = await readFile(path, "utf8");
      try {
        JSON.parse(text);
        reads += 1;
      } catch {
        parseFailures += 1;
      }
    }
  })();

  for (let tick = 0; tick < 500; tick += 1) {
    await writer.write({ state: "running", tick });
  }
  done = true;
  await reader;

  expect(parseFailures).toBe(0);
  expect(reads).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ state: "running", tick: 499 });
});
