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
import { setFleetDeps } from "../../../../fleet/fleet.service";
import { DELETE, dynamic, GET, PATCH, POST, PUT, runtime } from "./route";

// Deps are injected through the fleet.service seam — a fake adapter, never a
// launchctl shell-out. SCORE_HOME still points at a sandbox because the
// snapshot reads status.json/resolved.json straight from the state dir.
const NOW = new Date("2026-07-01T12:00:00.000Z");
let root: string;
const savedHome = process.env.SCORE_HOME;

const config: ScoreConfig = {
  version: 1,
  projects: {
    alpha: {
      enabled: true,
      main_location: "/tmp/alpha",
      worktree_location: "/tmp/wt",
      github_repo: "example/alpha",
      config: { agent: { harness: "claude" } },
    },
  },
};

function inject(jobs: JobStatus[], readConfig?: () => Promise<ScoreConfig | null>): void {
  const adapter: SupervisorAdapter = {
    install: async () => {},
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    status: async () => jobs,
  };
  setFleetDeps({ adapter, readConfig: readConfig ?? (async () => config), now: () => NOW });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "score-fleet-route-"));
  process.env.SCORE_HOME = root;
});

afterEach(async () => {
  setFleetDeps(null);
  if (savedHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

test("GET returns every project as the flattened wire shape", async () => {
  const dir = join(root, "projects", "alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({
      state: "running",
      pid: 41,
      updated_at: new Date(NOW.getTime() - 1000).toISOString(),
    }),
  );
  // A job the config no longer knows about must still appear (union view).
  inject([
    { key: "alpha", loaded: true, pid: 41 },
    { key: "zombie", loaded: true },
  ]);
  const res = await GET();
  expect(res.status).toBe(200);
  const body = JSON.parse(await res.text());
  expect(body.api_version).toBe("v1");
  expect(body.warnings).toEqual([]);
  expect(body.data.projects.map((project: { key: string }) => project.key)).toEqual([
    "alpha",
    "zombie",
  ]);
  const [alpha, zombie] = body.data.projects;
  expect(alpha).toMatchObject({
    key: "alpha",
    enabled: true,
    dot: "green",
    pid: 41,
    loaded: true,
    stopping: false,
    resolved: null,
  });
  expect(alpha.status.pid).toBe(41);
  expect(zombie).toMatchObject({
    key: "zombie",
    enabled: false,
    dot: "red",
    pid: null,
    loaded: true,
    status: null,
  });
});

test("a resolved project's repo rides the wire for GitHub links", async () => {
  const dir = join(root, "projects", "alpha");
  mkdirSync(dir, { recursive: true });
  // The camelCase key `score up` serializes; the console hides every GitHub
  // link if this ever arrives null, so the pass-through must be pinned.
  writeFileSync(
    join(dir, "resolved.json"),
    JSON.stringify({
      key: "alpha",
      githubRepo: "example/alpha",
      tickIntervalMs: 60_000,
      maxParallel: 1,
      agent: { harness: "claude" },
    }),
  );
  inject([{ key: "alpha", loaded: true, pid: 41 }]);
  const res = await GET();
  const body = JSON.parse(await res.text());
  expect(body.data.projects[0].resolved).toMatchObject({ repo: "example/alpha" });
});

test("unparseable config → 503 with only the enum reason", async () => {
  inject([], async () => null);
  const res = await GET();
  expect(res.status).toBe(503);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "CONFIG_UNPARSEABLE" }]);
  expect(text).not.toContain(root);
});

test("supervisor failure → 503 SUPERVISOR_UNREADABLE, no output leaks", async () => {
  const adapter: SupervisorAdapter = {
    install: async () => {},
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    status: async () => {
      throw new Error(`launchctl print gui/501 failed in ${root}`);
    },
  };
  setFleetDeps({ adapter, readConfig: async () => config, now: () => NOW });
  const res = await GET();
  expect(res.status).toBe(503);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "SUPERVISOR_UNREADABLE" }]);
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
