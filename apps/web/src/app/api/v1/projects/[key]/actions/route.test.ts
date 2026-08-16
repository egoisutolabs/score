import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JobStatus,
  SupervisorAdapter,
} from "@score/core/supervisor/supervisor-adapter.interface";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { afterEach, beforeEach, expect, test } from "vitest";
import { setFleetDeps } from "../../../../../../fleet/fleet.service";
import { DELETE, dynamic, GET, PATCH, POST, PUT, runtime } from "./route";

// Deps are injected through the fleet.service seam — a fake adapter records
// the lifecycle sequence, never a launchctl shell-out. SCORE_HOME points at a
// sandbox because start/restart read the saved job.plist from the state dir.
const NOW = new Date("2026-07-01T12:00:00.000Z");
let root: string;
let calls: string[];
const savedHome = process.env.SCORE_HOME;

function project(enabled: boolean) {
  return {
    enabled,
    main_location: "/tmp/p",
    worktree_location: "/tmp/wt",
    github_repo: "example/p",
    config: { agent: { harness: "claude" as const } },
  };
}

const config: ScoreConfig = {
  version: 1,
  projects: { alpha: project(true), disabled: project(false) },
};

function inject(jobs: JobStatus[], readConfig?: () => Promise<ScoreConfig | null>): void {
  const adapter: SupervisorAdapter = {
    install: async (key) => void calls.push(`install ${key}`),
    uninstall: async (key) => void calls.push(`uninstall ${key}`),
    start: async (key) => void calls.push(`start ${key}`),
    stop: async (key) => void calls.push(`stop ${key}`),
    status: async () => jobs,
  };
  setFleetDeps({ adapter, readConfig: readConfig ?? (async () => config), now: () => NOW });
}

function seedDefinition(key: string): void {
  const dir = join(root, "projects", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.plist"), "<plist/>");
}

function post(key: string, body: BodyInit, headers?: Record<string, string>): Promise<Response> {
  return POST(
    new Request(`http://127.0.0.1/api/v1/projects/${key}/actions`, {
      method: "POST",
      body,
      headers,
    }),
    { params: Promise.resolve({ key }) },
  );
}

function act(key: string, action: string): Promise<Response> {
  return post(key, JSON.stringify({ action }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "score-actions-route-"));
  process.env.SCORE_HOME = root;
  calls = [];
});

afterEach(async () => {
  setFleetDeps(null);
  if (savedHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

test("start of a booted-out project re-installs from the saved definition", async () => {
  seedDefinition("alpha");
  inject([{ key: "alpha", loaded: false }]);
  const res = await act("alpha", "start");
  expect(res.status).toBe(200);
  const body = JSON.parse(await res.text());
  expect(body.data).toEqual({ key: "alpha", action: "start" });
  expect(body.warnings).toEqual([]);
  expect(calls).toEqual(["install alpha", "start alpha"]);
});

test("start of a still-registered (crashed) job skips the re-install", async () => {
  // No definition seeded: a re-install attempt would fail loudly here.
  inject([{ key: "alpha", loaded: true }]);
  const res = await act("alpha", "start");
  expect(res.status).toBe(200);
  expect(calls).toEqual(["start alpha"]);
});

test("restart runs stop, install, start from the saved definition", async () => {
  seedDefinition("alpha");
  inject([{ key: "alpha", loaded: true, pid: 7 }]);
  const res = await act("alpha", "restart");
  expect(res.status).toBe(200);
  expect(calls).toEqual(["stop alpha", "install alpha", "start alpha"]);
});

test("restart with a missing saved definition fails before touching the supervisor", async () => {
  // The TUI's regression, ported with its app: restartProject must read the
  // definition BEFORE stopping — reversed order would boot out a running
  // daemon it cannot bring back. calls === [] is the assertion that matters.
  inject([{ key: "alpha", loaded: true, pid: 7 }]);
  const res = await act("alpha", "restart");
  expect(res.status).toBe(500);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "ACTION_FAILED" }]);
  expect(calls).toEqual([]);
});

test("start without a saved definition → 500 ACTION_FAILED, enum only", async () => {
  inject([{ key: "alpha", loaded: false }]);
  const res = await act("alpha", "start");
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "ACTION_FAILED" }]);
  expect(text).not.toContain(root);
  expect(calls).toEqual([]);
});

test("start of a config-disabled project → 400 PROJECT_DISABLED", async () => {
  inject([{ key: "disabled", loaded: false }]);
  const res = await act("disabled", "start");
  expect(res.status).toBe(400);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "PROJECT_DISABLED" }]);
  expect(calls).toEqual([]);
});

test("restart of a config-disabled project → 400 PROJECT_DISABLED", async () => {
  inject([{ key: "disabled", loaded: true, pid: 7 }]);
  const res = await act("disabled", "restart");
  expect(res.status).toBe(400);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "PROJECT_DISABLED" }]);
  expect(calls).toEqual([]);
});

test("stop of a config-disabled project is allowed", async () => {
  inject([{ key: "disabled", loaded: true, pid: 7 }]);
  const res = await act("disabled", "stop");
  expect(res.status).toBe(200);
  expect(calls).toEqual(["stop disabled"]);
});

test("unknown key → 404 PROJECT_UNKNOWN", async () => {
  inject([]);
  const res = await act("ghost", "start");
  expect(res.status).toBe(404);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "PROJECT_UNKNOWN" }]);
});

test("a job-only key (gone from config) is still stoppable", async () => {
  inject([{ key: "zombie", loaded: true, pid: 7 }]);
  const res = await act("zombie", "stop");
  expect(res.status).toBe(200);
  expect(calls).toEqual(["stop zombie"]);
});

test("malformed key → 400 before any filesystem or supervisor touch", async () => {
  inject([]);
  const res = await act("Not_A_Key", "start");
  expect(res.status).toBe(400);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "PROJECT_KEY_INVALID" }]);
});

test("unknown action and non-JSON body → 400 ACTION_INVALID", async () => {
  inject([{ key: "alpha", loaded: true, pid: 7 }]);
  for (const body of [JSON.stringify({ action: "explode" }), "not json"]) {
    const res = await post("alpha", body);
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "ACTION_INVALID" }]);
  }
  expect(calls).toEqual([]);
});

test("unparseable config → 503 CONFIG_UNPARSEABLE", async () => {
  inject([], async () => null);
  const res = await act("alpha", "start");
  expect(res.status).toBe(503);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "CONFIG_UNPARSEABLE" }]);
});

test("a cross-origin browser POST → 403, no supervisor touch", async () => {
  // The confused-deputy hole: a drive-by page can fire a no-preflight POST
  // at loopback; the browser attaches its Origin, and that is the tell.
  inject([{ key: "alpha", loaded: true, pid: 7 }]);
  for (const origin of ["https://evil.example", "null"]) {
    const res = await post("alpha", JSON.stringify({ action: "stop" }), { origin });
    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "ORIGIN_FORBIDDEN" }]);
  }
  expect(calls).toEqual([]);
});

test("the console's own same-origin POST passes the origin gate", async () => {
  inject([{ key: "alpha", loaded: true, pid: 7 }]);
  const res = await post("alpha", JSON.stringify({ action: "stop" }), {
    origin: "http://127.0.0.1",
  });
  expect(res.status).toBe(200);
  expect(calls).toEqual(["stop alpha"]);
});

test("non-POST verbs → 405, POST-only surface", () => {
  for (const handler of [GET, PUT, PATCH, DELETE]) {
    const res = handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  }
});

test("route is dynamic on the node runtime", () => {
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");
});
