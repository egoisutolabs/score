import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig, ScoreConfig } from "@/features/config/model";
import type { JobStatus, SupervisorAdapter } from "@/features/supervisor/adapter";
import { buildTui } from "@/features/tui/app";

const NOW = new Date("2026-07-01T12:00:00.000Z");

/** Lifecycle calls are recorded; status() is a read and is not. */
class FakeAdapter implements SupervisorAdapter {
  calls: string[] = [];
  jobs: JobStatus[] = [];
  stopGate: Promise<void> | null = null;

  async install(key: string, definition: string): Promise<void> {
    // The definition is part of the contract: x/r must pass the saved plist.
    this.calls.push(`install ${key} ${JSON.stringify(definition)}`);
  }

  async uninstall(key: string): Promise<void> {
    this.calls.push(`uninstall ${key}`);
  }

  async start(key: string): Promise<void> {
    this.calls.push(`start ${key}`);
  }

  async stop(key: string): Promise<void> {
    this.calls.push(`stop ${key}`);
    if (this.stopGate !== null) await this.stopGate;
  }

  async status(): Promise<JobStatus[]> {
    return this.jobs;
  }
}

function project(key: string): ProjectConfig {
  return {
    enabled: true,
    main_location: `/tmp/${key}`,
    worktree_location: `/tmp/wt/${key}`,
    github_repo: `example/${key}`,
    config: { agent: { harness: "claude" } },
  };
}

const config: ScoreConfig = {
  version: 1,
  projects: { alpha: project("alpha"), beta: project("beta") },
};

async function writeFixtures(home: string): Promise<void> {
  const status = (key: string, updatedAt: Date, tick: number) =>
    writeFile(
      join(home, "projects", key, "status.json"),
      JSON.stringify({
        state: "running",
        pid: key === "alpha" ? 111 : 222,
        tick,
        last_pass_started_at: null,
        last_pass_completed_at: null,
        last_error: null,
        last_gate_failure: null,
        updated_at: updatedAt.toISOString(),
      }),
    );
  const resolved = (key: string) =>
    writeFile(
      join(home, "projects", key, "resolved.json"),
      JSON.stringify({
        key,
        tickIntervalMs: 60_000,
        maxParallel: 2,
        agent: { harness: "claude", model: "sonnet" },
      }),
    );
  for (const key of ["alpha", "beta"]) {
    await mkdir(join(home, "projects", key, "logs"), { recursive: true });
    await resolved(key);
  }
  await status("alpha", new Date(NOW.getTime() - 1000), 12);
  // Ten minutes past a 60s tick interval: stale.
  await status("beta", new Date(NOW.getTime() - 600_000), 3);
  await writeFile(
    join(home, "projects", "alpha", "logs", "2026-07-01.log"),
    [
      "[2026-07-01T11:59:58.000Z] [info] tick 12 started",
      "[2026-07-01T11:59:59.000Z] [info] nothing to dispatch",
    ]
      .map((line) => `${line}\n`)
      .join(""),
  );
  await writeFile(join(home, "projects", "alpha", "job.plist"), PLIST);
}

const PLIST = "<plist alpha/>\n";
const INSTALL_ALPHA = `install alpha ${JSON.stringify(PLIST)}`;

// OpenTUI's test renderer needs native FFI; vitest.config.ts only passes the
// flag on Node >= 26.4. Without it these tests skip instead of crashing the
// worker — the pure TUI logic (dots, tail, boundary) still runs everywhere.
const hasFfi = process.execArgv.includes("--experimental-ffi");

describe.skipIf(!hasFfi)("tui app", () => {
  let createTestRenderer: typeof import("@opentui/core/testing").createTestRenderer;
  let home: string;
  let adapter: FakeAdapter;
  let destroy: (() => void) | null = null;

  beforeAll(async () => {
    // Dynamic so a skipped run never loads OpenTUI's native bindings.
    ({ createTestRenderer } = await import("@opentui/core/testing"));
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "score-tui-"));
    process.env.SCORE_HOME = home;
    await writeFixtures(home);
    adapter = new FakeAdapter();
    adapter.jobs = [
      { key: "alpha", loaded: true, pid: 111 },
      { key: "beta", loaded: true, pid: 222 },
    ];
  });

  afterEach(async () => {
    destroy?.();
    destroy = null;
    delete process.env.SCORE_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(width: number, height: number) {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width, height });
    destroy = () => renderer.destroy();
    const app = buildTui(renderer, { adapter, config, now: () => NOW });
    await app.refresh();
    return { app, renderOnce, captureCharFrame };
  }

  it("matches the checked-in 80x24 frame", async () => {
    const { renderOnce, captureCharFrame } = await setup(80, 24);
    await renderOnce();
    await expect(captureCharFrame()).toMatchFileSnapshot("__frames__/frame-80x24.txt");
  });

  it("matches the checked-in 120x40 frame", async () => {
    const { renderOnce, captureCharFrame } = await setup(120, 40);
    await renderOnce();
    await expect(captureCharFrame()).toMatchFileSnapshot("__frames__/frame-120x40.txt");
  });

  it("q resolves done without ever touching the adapter", async () => {
    const { app } = await setup(80, 24);
    app.handleKey({ name: "q" });
    await app.done;
    expect(adapter.calls).toEqual([]);
  });

  it("navigation and view keys never touch the adapter", async () => {
    const { app } = await setup(80, 24);
    for (const name of ["j", "k", "f", "g", "?", "down", "up"]) {
      app.handleKey({ name });
    }
    app.handleKey({ name: "g", shift: true });
    expect(adapter.calls).toEqual([]);
  });

  it("x on a running project stops it via the adapter, exactly once", async () => {
    const { app } = await setup(80, 24);
    app.handleKey({ name: "x" });
    expect(adapter.calls).toEqual(["stop alpha"]);
  });

  it("x on a stopped project re-installs the saved definition and starts it", async () => {
    adapter.jobs = [
      { key: "alpha", loaded: false },
      { key: "beta", loaded: true, pid: 222 },
    ];
    const { app } = await setup(80, 24);
    app.handleKey({ name: "x" });
    await vi.waitFor(() => expect(adapter.calls).toEqual([INSTALL_ALPHA, "start alpha"]));
  });

  it("x on a crashed job (registered, no pid) starts without re-installing", async () => {
    adapter.jobs = [
      { key: "alpha", loaded: true },
      { key: "beta", loaded: true, pid: 222 },
    ];
    const { app } = await setup(80, 24);
    app.handleKey({ name: "x" });
    await vi.waitFor(() => expect(adapter.calls).toEqual(["start alpha"]));
  });

  it("r restarts: stop, then install + start from the saved definition", async () => {
    const { app } = await setup(80, 24);
    app.handleKey({ name: "r" });
    await vi.waitFor(() =>
      expect(adapter.calls).toEqual(["stop alpha", INSTALL_ALPHA, "start alpha"]),
    );
  });

  it("ignores lifecycle keys while an action is in flight — no retry storm", async () => {
    let release!: () => void;
    adapter.stopGate = new Promise((resolve) => {
      release = resolve;
    });
    const { app } = await setup(80, 24);
    app.handleKey({ name: "x" });
    app.handleKey({ name: "x" });
    app.handleKey({ name: "r" });
    expect(adapter.calls).toEqual(["stop alpha"]);
    release();
  });

  it("acting on a stopped-then-started project follows the adapter, not optimistic state", async () => {
    const { app, renderOnce, captureCharFrame } = await setup(80, 24);
    app.handleKey({ name: "x" });
    // The rail still shows alpha running until a poll observes otherwise.
    await renderOnce();
    expect(captureCharFrame()).toContain("pid 111");
    adapter.jobs = [
      { key: "alpha", loaded: false },
      { key: "beta", loaded: true, pid: 222 },
    ];
    await app.refresh();
    await renderOnce();
    expect(captureCharFrame()).not.toContain("pid 111");
  });

  it("a failing adapter action lands in the footer and changes nothing else", async () => {
    adapter.stop = async () => {
      throw new Error("launchctl exploded");
    };
    const { app, renderOnce, captureCharFrame } = await setup(80, 24);
    app.handleKey({ name: "x" });
    await vi.waitFor(async () => {
      await renderOnce();
      expect(captureCharFrame()).toContain("error: launchctl exploded");
    });
  });
});
