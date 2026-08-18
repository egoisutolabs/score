import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JobStatus,
  SupervisorAdapter,
} from "@score/core/supervisor/supervisor-adapter.interface";
import type { ProjectView, TuiDataSource, TuiPoll } from "@score/tui/server-client.interface";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

async function writeFixtures(home: string): Promise<void> {
  await mkdir(join(home, "projects", "alpha"), { recursive: true });
  await writeFile(join(home, "projects", "alpha", "job.plist"), PLIST);
}

class FakeDataSource implements TuiDataSource {
  readonly disabled = new Set<string>();

  constructor(private readonly adapter: FakeAdapter) {}

  async poll(): Promise<TuiPoll> {
    const jobs = new Map(this.adapter.jobs.map((job) => [job.key, job]));
    const view = (key: string, tick: number, dot: ProjectView["dot"]): ProjectView => ({
      key,
      enabled: !this.disabled.has(key),
      job: jobs.get(key),
      status: { tick },
      resolved: { agent: "claude · sonnet", tickIntervalMs: 60_000, maxParallel: 2 },
      dot,
    });
    return {
      projects: [view("alpha", 12, "green"), view("beta", 3, "amber")],
      logs: new Map([
        [
          "alpha",
          [
            "[2026-07-01T11:59:58.000Z] [info] tick 12 started",
            "[2026-07-01T11:59:59.000Z] [info] nothing to dispatch",
          ],
        ],
      ]),
      logFile: "2026-07-01.log",
      warnings: [],
    };
  }
}

const PLIST = "<plist alpha/>\n";
const INSTALL_ALPHA = `install alpha ${JSON.stringify(PLIST)}`;
const cleanFrame = (frame: string): string => frame.replace(/[ \t]+$/gm, "");

// OpenTUI's test renderer needs native FFI; vitest.config.ts only passes the
// flag on Node >= 26.4. Without it these tests skip instead of crashing the
// worker — the pure TUI logic (server client, dots, boundary) still runs everywhere.
const hasFfi = process.execArgv.includes("--experimental-ffi");

describe.skipIf(!hasFfi)("tui app", () => {
  let createTestRenderer: typeof import("@opentui/core/testing").createTestRenderer;
  let buildTui: typeof import("@score/tui/app").buildTui;
  let home: string;
  let adapter: FakeAdapter;
  let data: FakeDataSource;
  let destroy: (() => void) | null = null;

  beforeAll(async () => {
    // Dynamic so a skipped run never loads OpenTUI's native bindings —
    // app.ts imports @opentui/core at module scope, so it stays behind the
    // guard too.
    ({ createTestRenderer } = await import("@opentui/core/testing"));
    ({ buildTui } = await import("@score/tui/app"));
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
    data = new FakeDataSource(adapter);
  });

  afterEach(async () => {
    destroy?.();
    destroy = null;
    delete process.env.SCORE_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(width: number, height: number, disabled: readonly string[] = []) {
    for (const key of disabled) data.disabled.add(key);
    const { renderer, renderOnce, captureCharFrame, captureSpans } = await createTestRenderer({
      width,
      height,
    });
    destroy = () => renderer.destroy();
    const app = buildTui(renderer, { adapter, data });
    await app.refresh();
    return { app, renderOnce, captureCharFrame, captureSpans };
  }

  it("matches the checked-in 80x24 frame", async () => {
    const { renderOnce, captureCharFrame } = await setup(80, 24);
    await renderOnce();
    await expect(cleanFrame(captureCharFrame())).toMatchFileSnapshot("fixtures/frame-80x24.txt");
  });

  it("matches the checked-in 120x40 frame", async () => {
    const { renderOnce, captureCharFrame } = await setup(120, 40);
    await renderOnce();
    await expect(cleanFrame(captureCharFrame())).toMatchFileSnapshot("fixtures/frame-120x40.txt");
  });

  it("uses the dashboard palette for surfaces and status accents", async () => {
    const { renderOnce, captureSpans } = await setup(80, 24);
    await renderOnce();
    const spans = captureSpans().lines.flatMap((line) => line.spans);
    const foregrounds = spans.map((span) => span.fg.toInts().slice(0, 3).join(","));
    const backgrounds = spans.map((span) => span.bg.toInts().slice(0, 3).join(","));
    expect(foregrounds).toEqual(expect.arrayContaining(["61,220,132", "255,180,84", "86,212,221"]));
    expect(backgrounds).toEqual(expect.arrayContaining(["11,14,20", "13,17,24", "22,28,38"]));
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

  it("r with a missing saved definition fails before touching the supervisor", async () => {
    await rm(join(home, "projects", "alpha", "job.plist"));
    const { app, renderOnce, captureCharFrame } = await setup(80, 24);
    app.handleKey({ name: "r" });
    await vi.waitFor(async () => {
      await renderOnce();
      expect(captureCharFrame()).toContain("error: no job definition for 'alpha'");
    });
    // The running daemon was never booted out.
    expect(adapter.calls).toEqual([]);
  });

  it("x and r never start a project disabled in config", async () => {
    adapter.jobs = [
      { key: "alpha", loaded: false },
      { key: "beta", loaded: true, pid: 222 },
    ];
    const { app, renderOnce, captureCharFrame } = await setup(80, 24, ["alpha"]);
    app.handleKey({ name: "x" });
    app.handleKey({ name: "r" });
    await renderOnce();
    expect(captureCharFrame()).toContain("error: 'alpha' is disabled in config");
    expect(adapter.calls).toEqual([]);
  });

  it("x still stops a running project that is disabled in config", async () => {
    const { app } = await setup(80, 24, ["alpha"]);
    app.handleKey({ name: "x" });
    expect(adapter.calls).toEqual(["stop alpha"]);
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
