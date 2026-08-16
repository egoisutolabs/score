import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { dynamic, GET, runtime } from "./route";

// The route reads SCORE_HOME at request time, so each test points it at a
// fresh sandbox. Semantics matrix lives in readiness.service.test.ts; this
// covers the HTTP shaping and the never-present list on error payloads.
let root: string;
const savedHome = process.env.SCORE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "score-readyz-route-"));
  process.env.SCORE_HOME = root;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

function seed(relative: string, text: string): void {
  const path = join(root, "projects", relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test("ready store → 200 ok", async () => {
  seed("alpha/resolved.json", '{"key":"alpha"}');
  const res = GET();
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("empty score home → 200 (absence is ready)", () => {
  expect(GET().status).toBe(200);
});

test("unparseable config → 503 envelope with only the enum reason", async () => {
  seed("alpha/resolved.json", "{not json");
  const res = GET();
  expect(res.status).toBe(503);
  const text = await res.text();
  const body = JSON.parse(text);
  expect(body.api_version).toBe("v1");
  expect(body.data).toBeNull();
  expect(body.warnings).toEqual([{ reason: "CONFIG_UNPARSEABLE" }]);
  assertSafe(text);
});

test("broken today segment → 503 SEGMENT_UNREADABLE, never-present list absent", async () => {
  seed("alpha/resolved.json", '{"key":"alpha"}');
  const stamp = new Date().toISOString().slice(0, 10);
  seed(`alpha/telemetry/${stamp}.jsonl`, "not json\n");
  const res = GET();
  expect(res.status).toBe(503);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "SEGMENT_UNREADABLE" }]);
  assertSafe(text);
});

test("route is dynamic on the node runtime", () => {
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");
});

/** The never-present list: absolute paths, environment values, stack traces, raw command output. */
function assertSafe(text: string): void {
  // The sandbox path is both the on-disk absolute path and an environment
  // value (SCORE_HOME) — its absence covers the first two at once.
  expect(text).not.toContain(root);
  expect(text).not.toContain(tmpdir());
  expect(text).not.toMatch(/\bat .+:\d+/); // stack frame shape
  // Whole-body shape check: nothing rides along beside the envelope fields,
  // and the warning carries the reason alone.
  const body = JSON.parse(text);
  expect(Object.keys(body).sort()).toEqual([
    "api_version",
    "cursor",
    "data",
    "emitted_at",
    "stream_id",
    "warnings",
  ]);
  expect(Object.keys(body.warnings[0])).toEqual(["reason"]);
}
