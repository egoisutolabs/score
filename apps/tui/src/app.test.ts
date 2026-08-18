import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JobStatus,
  SupervisorAdapter,
} from "@score/core/supervisor/supervisor-adapter.interface";
import { ScoreTui } from "@score/tui/app";
import type { GitHubMerge, HistoryEvent } from "@score/tui/history/history.interface";
import type { ProjectView, TuiDataSource, TuiPoll } from "@score/tui/server-client.interface";
import { TuiService } from "@score/tui/tui.service";
import { cleanup as cleanupInk, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  keys = ["alpha", "beta"];
  logLines = [
    "[2026-07-01T11:59:58.000Z] [info] tick 12 started",
    "[2026-07-01T11:59:59.000Z] [info] nothing to dispatch",
  ];
  history: HistoryEvent[] = [
    {
      project: "alpha",
      ts: "2026-07-01T11:40:00.000Z",
      name: "score.landing.decision",
      subject: { pull_request_number: 41 },
      attributes: { tag: "soaking", dry_run: false },
    },
    {
      project: "alpha",
      ts: "2026-07-01T11:50:00.000Z",
      name: "score.landing.decision",
      subject: { pull_request_number: 41 },
      attributes: { tag: "merged", dry_run: false },
    },
    {
      project: "beta",
      ts: "2026-07-01T11:55:00.000Z",
      name: "score.landing.decision",
      subject: { pull_request_number: 42 },
      attributes: { tag: "merged", dry_run: false },
    },
  ];
  githubMerges: GitHubMerge[] = [
    {
      project: "alpha",
      pullRequest: 103,
      title: "Port API to Express",
      mergedTs: "2026-07-01T11:57:00.000Z",
    },
    {
      project: "alpha",
      pullRequest: 102,
      title: "Share live stream tailers",
      mergedTs: "2026-06-28T08:31:00.000Z",
    },
    {
      project: "beta",
      pullRequest: 101,
      title: "Replay telemetry snapshots",
      mergedTs: "2026-06-24T07:10:00.000Z",
    },
    {
      project: "alpha",
      pullRequest: 100,
      title: "Install dependencies before verify",
      mergedTs: "2026-06-24T06:46:00.000Z",
    },
    {
      project: "beta",
      pullRequest: 99,
      title: "Repair score up reconciliation",
      mergedTs: "2026-06-15T06:32:00.000Z",
    },
  ];

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
      projects: this.keys.map((key, index) =>
        view(key, index === 0 ? 12 : index + 2, index === 1 ? "amber" : "green"),
      ),
      logs: new Map([["alpha", this.logLines]]),
      logFile: "2026-07-01.log",
      history: this.history,
      githubMerges: this.githubMerges,
      warnings: [],
    };
  }
}

const PLIST = "<plist alpha/>\n";
const INSTALL_ALPHA = `install alpha ${JSON.stringify(PLIST)}`;
const cleanFrame = (frame: string): string => frame.replace(/[ \t]+$/gm, "");

describe("tui app", () => {
  let home: string;
  let adapter: FakeAdapter;
  let data: FakeDataSource;
  let service: TuiService;
  let view: ReturnType<typeof render> | null = null;

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
    service = new TuiService({ adapter, data });
  });

  afterEach(async () => {
    view?.cleanup();
    view = null;
    cleanupInk();
    delete process.env.SCORE_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(width: number, height: number, disabled: readonly string[] = []) {
    for (const key of disabled) data.disabled.add(key);
    await service.refresh();
    view = render(createElement(ScoreTui, { service, columns: width, rows: height }));
    await vi.waitFor(() => expect(view?.lastFrame()).toContain("PROJECTS"));
    return view;
  }

  it("matches the checked-in 80x24 frame", async () => {
    const rendered = await setup(80, 24);
    await expect(cleanFrame(rendered.lastFrame() ?? "")).toMatchFileSnapshot(
      "fixtures/frame-80x24.txt",
    );
  });

  it("matches the checked-in 120x40 frame", async () => {
    const rendered = await setup(120, 40);
    await expect(cleanFrame(rendered.lastFrame() ?? "")).toMatchFileSnapshot(
      "fixtures/frame-120x40.txt",
    );
  });

  it("matches the checked-in 80x24 history frame", async () => {
    const rendered = await setup(80, 24);
    rendered.stdin.write("2");
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain("HISTORY / 30d"));
    await expect(cleanFrame(rendered.lastFrame() ?? "")).toMatchFileSnapshot(
      "fixtures/history-80x24.txt",
    );
  });

  it("switches between overview and history without touching the adapter", async () => {
    const rendered = await setup(80, 24);
    rendered.stdin.write("2");
    await vi.waitFor(() => expect(service.snapshot.view).toBe("history"));
    expect(rendered.lastFrame()).toContain("RECENT MERGES");
    expect(rendered.lastFrame()).not.toContain("PROJECTS");

    rendered.stdin.write("7");
    await vi.waitFor(() => expect(service.snapshot.historyDays).toBe(7));
    expect(rendered.lastFrame()).toContain("HISTORY / 7d");
    rendered.stdin.write("3");
    await vi.waitFor(() => expect(service.snapshot.historyDays).toBe(30));

    rendered.stdin.write("\t");
    await vi.waitFor(() => expect(service.snapshot.view).toBe("overview"));
    expect(rendered.lastFrame()).toContain("PROJECTS");
    expect(adapter.calls).toEqual([]);
  });

  it("keeps the shortcut footer and selected project visible for a larger fleet", async () => {
    data.keys = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const rendered = await setup(80, 24);
    expect(rendered.lastFrame()).toContain("q quit");

    for (let index = 0; index < data.keys.length - 1; index++) service.handleKey({ name: "j" });
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain("PROJECTS 6"));
    expect(rendered.lastFrame()).toContain("zeta");
    expect(rendered.lastFrame()).toContain("q quit");
  });

  it("Ink input drives navigation without touching the adapter", async () => {
    const rendered = await setup(80, 24);
    rendered.stdin.write("j");
    await vi.waitFor(() => expect(service.snapshot.selectedKey).toBe("beta"));
    expect(adapter.calls).toEqual([]);
  });

  it("q exits without ever touching the adapter", async () => {
    await setup(80, 24);
    expect(service.handleKey({ name: "q" })).toBe(true);
    expect(adapter.calls).toEqual([]);
  });

  it("navigation and view keys never touch the adapter", async () => {
    await setup(80, 24);
    for (const name of [
      "j",
      "k",
      "u",
      "d",
      "pageup",
      "pagedown",
      "f",
      "g",
      "c",
      "1",
      "2",
      "3",
      "7",
      "tab",
      "?",
      "down",
      "up",
    ]) {
      service.handleKey({ name });
    }
    service.handleKey({ name: "g", shift: true });
    expect(adapter.calls).toEqual([]);
  });

  it("removes the project rail in copy view so log selection stays clean", async () => {
    const rendered = await setup(80, 24);
    rendered.stdin.write("c");
    await vi.waitFor(() => expect(service.snapshot.copyMode).toBe(true));
    expect(rendered.lastFrame()).toContain("COPY VIEW");
    expect(rendered.lastFrame()).toContain("nothing to dispatch");
    expect(rendered.lastFrame()).not.toContain("PROJECTS");
    expect(rendered.lastFrame()).not.toContain("AGENT");

    rendered.stdin.write("\u001b");
    await vi.waitFor(() => expect(service.snapshot.copyMode).toBe(false));
    expect(rendered.lastFrame()).toContain("PROJECTS");
  });

  it("scrolls logs without changing the selected project", async () => {
    data.logLines = Array.from(
      { length: 30 },
      (_, index) =>
        `[2026-07-01T12:00:${String(index).padStart(2, "0")}.000Z] [info] line ${index}`,
    );
    const rendered = await setup(80, 24);
    expect(rendered.lastFrame()).toContain("line 29");

    rendered.stdin.write("u");
    await vi.waitFor(() => expect(service.snapshot.logStart).toBe(14));
    expect(service.snapshot.selectedKey).toBe("alpha");
    expect(rendered.lastFrame()).toContain("PAUSED 15/30");
    expect(rendered.lastFrame()).toContain("line 14");
    expect(rendered.lastFrame()).not.toContain("line 29");

    rendered.stdin.write("d");
    await vi.waitFor(() => expect(service.snapshot.logStart).toBe(22));
    expect(rendered.lastFrame()).toContain("line 22");
    rendered.stdin.write("G");
    await vi.waitFor(() => expect(service.snapshot.follow).toBe(true));
    expect(rendered.lastFrame()).toContain("line 29");
  });

  it("x on a running project stops it via the adapter, exactly once", async () => {
    await setup(80, 24);
    service.handleKey({ name: "x" });
    expect(adapter.calls).toEqual(["stop alpha"]);
  });

  it("x on a stopped project re-installs the saved definition and starts it", async () => {
    adapter.jobs = [
      { key: "alpha", loaded: false },
      { key: "beta", loaded: true, pid: 222 },
    ];
    await setup(80, 24);
    service.handleKey({ name: "x" });
    await vi.waitFor(() => expect(adapter.calls).toEqual([INSTALL_ALPHA, "start alpha"]));
  });

  it("x on a crashed job starts without re-installing", async () => {
    adapter.jobs = [
      { key: "alpha", loaded: true },
      { key: "beta", loaded: true, pid: 222 },
    ];
    await setup(80, 24);
    service.handleKey({ name: "x" });
    await vi.waitFor(() => expect(adapter.calls).toEqual(["start alpha"]));
  });

  it("r restarts from the saved definition", async () => {
    await setup(80, 24);
    service.handleKey({ name: "r" });
    await vi.waitFor(() =>
      expect(adapter.calls).toEqual(["stop alpha", INSTALL_ALPHA, "start alpha"]),
    );
  });

  it("r with a missing saved definition fails before touching the supervisor", async () => {
    await rm(join(home, "projects", "alpha", "job.plist"));
    const rendered = await setup(80, 24);
    service.handleKey({ name: "r" });
    await vi.waitFor(() =>
      expect(rendered.lastFrame()).toContain("error: no job definition for 'alpha'"),
    );
    expect(adapter.calls).toEqual([]);
  });

  it("x and r never start a project disabled in config", async () => {
    adapter.jobs = [
      { key: "alpha", loaded: false },
      { key: "beta", loaded: true, pid: 222 },
    ];
    const rendered = await setup(80, 24, ["alpha"]);
    service.handleKey({ name: "x" });
    service.handleKey({ name: "r" });
    await vi.waitFor(() =>
      expect(rendered.lastFrame()).toContain("error: 'alpha' is disabled in config"),
    );
    expect(adapter.calls).toEqual([]);
  });

  it("x still stops a running project disabled in config", async () => {
    await setup(80, 24, ["alpha"]);
    service.handleKey({ name: "x" });
    expect(adapter.calls).toEqual(["stop alpha"]);
  });

  it("ignores lifecycle keys while an action is in flight", async () => {
    let release!: () => void;
    adapter.stopGate = new Promise((resolve) => {
      release = resolve;
    });
    await setup(80, 24);
    service.handleKey({ name: "x" });
    service.handleKey({ name: "x" });
    service.handleKey({ name: "r" });
    expect(adapter.calls).toEqual(["stop alpha"]);
    release();
  });

  it("renders observed supervisor state instead of optimistic state", async () => {
    const rendered = await setup(80, 24);
    service.handleKey({ name: "x" });
    expect(rendered.lastFrame()).toContain("pid 111");
    adapter.jobs = [
      { key: "alpha", loaded: false },
      { key: "beta", loaded: true, pid: 222 },
    ];
    await service.refresh();
    await vi.waitFor(() => expect(rendered.lastFrame()).not.toContain("pid 111"));
  });

  it("lands adapter failures in the footer", async () => {
    adapter.stop = async () => {
      throw new Error("launchctl exploded");
    };
    const rendered = await setup(80, 24);
    service.handleKey({ name: "x" });
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain("error: launchctl exploded"));
    expect(rendered.lastFrame()).toContain("q quit");
  });
});
