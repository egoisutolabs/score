import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupervisorAdapter } from "@score/core/supervisor/supervisor-adapter.interface";
import { afterEach, beforeEach, expect, test } from "vitest";
import { setFleetDeps } from "../../../../../../fleet/fleet.service";
import { DELETE, dynamic, GET, PATCH, POST, PUT, runtime } from "./route";

// The route resolves the dated file from the injected clock and SCORE_HOME;
// each test seeds a sandboxed logs dir. Tail semantics (caps, truncation,
// rotation) are proven in src/fleet/tail.service.test.ts; this file covers
// the HTTP shaping: verbs, statuses, the envelope, and cursor round-trips.
const NOW = new Date("2026-07-01T12:00:00.000Z");
const TODAY = "2026-07-01.log";
let root: string;
const savedHome = process.env.SCORE_HOME;

const idleAdapter: SupervisorAdapter = {
  install: async () => {},
  uninstall: async () => {},
  start: async () => {},
  stop: async () => {},
  status: async () => [],
};

function seedLog(key: string, text: string): void {
  const dir = join(root, "projects", key, "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TODAY), text);
}

function get(key: string, cursor?: string): Promise<Response> {
  const search = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return GET(new Request(`http://127.0.0.1/api/v1/projects/${key}/logs${search}`), {
    params: Promise.resolve({ key }),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "score-logs-route-"));
  process.env.SCORE_HOME = root;
  setFleetDeps({
    adapter: idleAdapter,
    readConfig: async () => ({ version: 1, projects: {} }),
    now: () => NOW,
  });
});

afterEach(async () => {
  setFleetDeps(null);
  if (savedHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

test("first poll returns the tail window inside the v1 envelope", async () => {
  seedLog("alpha", "line 0\nline 1\n");
  const res = await get("alpha");
  expect(res.status).toBe(200);
  const body = JSON.parse(await res.text());
  expect(body.api_version).toBe("v1");
  expect(body.warnings).toEqual([]);
  expect(body.data.file).toBe(TODAY);
  expect(body.data.lines).toEqual(["line 0", "line 1"]);
  expect(body.data.reset).toBe(false);
  expect(typeof body.data.cursor).toBe("string");
});

test("an echoed cursor returns only the lines appended since", async () => {
  seedLog("alpha", "line 0\n");
  const first = JSON.parse(await (await get("alpha")).text());
  seedLog("alpha", "line 0\nline 1\nline 2\n");
  const second = JSON.parse(await (await get("alpha", first.data.cursor)).text());
  expect(second.data.lines).toEqual(["line 1", "line 2"]);
  expect(second.data.reset).toBe(false);
});

test("a garbage cursor degrades to a fresh tail, never a 500", async () => {
  seedLog("alpha", "line 0\n");
  const res = await get("alpha", "@@not-a-cursor@@");
  expect(res.status).toBe(200);
  const body = JSON.parse(await res.text());
  expect(body.data.lines).toEqual(["line 0"]);
  expect(body.data.reset).toBe(true);
});

test("a project with no log yet returns an empty window, not an error", async () => {
  const res = await get("alpha");
  expect(res.status).toBe(200);
  const body = JSON.parse(await res.text());
  expect(body.data.lines).toEqual([]);
  expect(body.data.file).toBe(TODAY);
});

test("malformed key → 400 before any filesystem touch", async () => {
  const res = await get("Not_A_Key");
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "PROJECT_KEY_INVALID" }]);
  expect(text).not.toContain(root);
});

test("mutating verbs → 405, GET-only surface", () => {
  for (const handler of [POST, PUT, PATCH, DELETE]) {
    const res = handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  }
});

test("route is dynamic on the node runtime", () => {
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");
});
