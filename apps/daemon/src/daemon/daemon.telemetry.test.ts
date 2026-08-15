import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusWriter } from "@score/core/daemon/status.service";
import type { TelemetryRecord, TelemetrySpan } from "@score/core/telemetry/telemetry.interface";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import type { AgentConfig, ScoreConfig } from "@score/shared/config/config.interface";
import { resolveProjects } from "@score/shared/config/resolve";
import { createFileLogger } from "@score/shared/file-log";
import type { Logger, LogLine } from "@score/shared/log";
import { expect, test } from "vitest";
import { parseDaemonArguments, runDaemonLoop } from "./daemon.run";

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly respond: (command: readonly string[]) => {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    },
  ) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([...command]);
    const response = this.respond(command);
    return {
      command,
      cwd: options.cwd,
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      timedOut: false,
      dryRun: false,
    };
  }
}

class CaptureLogger implements Logger {
  readonly logged: LogLine[] = [];
  info(text: string): void {
    this.logged.push({ level: "info", text });
  }
  warn(text: string): void {
    this.logged.push({ level: "warn", text });
  }
  debug(text: string): void {
    this.logged.push({ level: "debug", text });
  }
  lines(lines: readonly LogLine[]): void {
    this.logged.push(...lines);
  }
}

const SEEDED_ISSUE = 7;

/** managedFixture from daemon.run.test.ts, minimal: one demo project, 5s tick. */
async function managedHome(
  mainLocation: string,
  agent: AgentConfig = { harness: "claude", model: "claude-sonnet-5" },
): Promise<{ home: string; worktree: string }> {
  const home = await mkdtemp(join(tmpdir(), "score-home-"));
  const worktree = join(home, "wt-demo");
  const config: ScoreConfig = {
    version: 1,
    projects: {
      demo: {
        enabled: true,
        main_location: mainLocation,
        worktree_location: worktree,
        github_repo: "egoisutolabs/demo",
        config: { tick_interval_ms: 5000, max_parallel: 2, agent },
      },
    },
  };
  const [project] = resolveProjects(config);
  await mkdir(join(home, "projects", "demo"), { recursive: true });
  await writeFile(join(home, "projects", "demo", "resolved.json"), JSON.stringify(project));
  return { home, worktree };
}

/** One seeded dispatchable issue; empty PR lists; clean reconcile. */
function responses(repo: string) {
  const issueJson = JSON.stringify({
    number: SEEDED_ISSUE,
    title: "Demo issue",
    body: "",
    labels: [{ name: "epic:demo" }],
    state: "OPEN",
    stateReason: null,
    url: "https://github.com/egoisutolabs/demo/issues/7",
  });
  return (command: readonly string[]): { exitCode?: number; stdout?: string; stderr?: string } => {
    if (command[0] === "gh" && command[1] === "issue" && command[2] === "list") {
      return { stdout: `[${issueJson}]\n` };
    }
    if (command[0] === "gh" && command[1] === "issue") return { stdout: `${issueJson}\n` };
    if (command[0] === "gh" && command[1] === "pr") return { stdout: "[]\n" };
    if (command[1] === "rev-parse" && command.includes("--abbrev-ref")) {
      return { stdout: "origin/develop\n" };
    }
    if (command[1] === "rev-parse") return { stdout: `${repo}\n` };
    if (command[1] === "remote") return { stdout: "git@github.com:egoisutolabs/demo.git\n" };
    if (command[1] === "config") return { exitCode: 1 };
    if (command[1] === "repo") return { stdout: '{"nameWithOwner":"egoisutolabs/demo"}\n' };
    if (command[1] === "set-environment") return { exitCode: 1 };
    // #64's fail-closed sessionExists: exit 1 alone is not absence — tmux's
    // own "can't find session" stderr is what confirms the session is gone.
    if (command[1] === "has-session") return { exitCode: 1, stderr: "can't find session\n" };
    if (command[1] === "symbolic-ref") return { stdout: "refs/remotes/origin/develop\n" };
    return {};
  };
}

interface LoopRun {
  readonly log: CaptureLogger;
  readonly commands: readonly string[][];
}

async function withHomeEnv(home: string, body: () => Promise<LoopRun>): Promise<LoopRun> {
  const saved = process.env.SCORE_HOME;
  process.env.SCORE_HOME = home;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.SCORE_HOME;
    else process.env.SCORE_HOME = saved;
  }
}

async function runOnce(repo: string, home: string): Promise<LoopRun> {
  return withHomeEnv(home, async () => {
    const runner = new FakeRunner(responses(repo));
    const log = new CaptureLogger();
    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new StatusWriter(join(runsDir, "status.json"));
    const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);
    await runDaemonLoop(parsed, log, { fileLog, status }, { runner });
    return { log, commands: runner.calls.map((call) => [...call]) };
  });
}

async function readTelemetry(home: string): Promise<TelemetryRecord[]> {
  const dir = join(home, "projects", "demo", "telemetry");
  const names = await readdir(dir);
  const records: TelemetryRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".jsonl")).sort()) {
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
      if (line !== "") records.push(JSON.parse(line) as TelemetryRecord);
    }
  }
  return records;
}

test("one dry-run pass yields one tick root span with ordered phase children sharing its trace", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedHome(repo);
  await runOnce(repo, home);

  const records = await readTelemetry(home);
  const spans = records.filter((record) => record.kind === "span") as TelemetrySpan[];
  const events = records.filter((record) => record.name.endsWith(".decision"));

  const tick = spans.find((span) => span.name === "score.tick");
  expect(tick).toBeDefined();
  expect(spans.filter((span) => span.name === "score.tick")).toHaveLength(1);
  expect(tick?.resource).toEqual({ project: "demo", daemon_pid: process.pid });

  // Tick 0: all three phases are due, in the daemon's fixed order.
  const phaseNames = spans
    .filter((span) => span.name === "score.phase")
    .map((span) => span.attributes?.["score.phase.name"]);
  expect(phaseNames).toEqual(["cleanup+dispatch", "landing", "repair"]);

  // Every phase span is a child of the tick span and shares its trace.
  const traceId = tick?.attributes?.trace_id;
  expect(typeof traceId).toBe("string");
  for (const span of spans) {
    expect(span.attributes?.trace_id).toBe(traceId);
    expect(span.attributes?.["score.tick.number"]).toBe(0);
    expect(span.attributes?.["score.dry_run"]).toBe(true);
  }
  for (const phase of spans.filter((span) => span.name === "score.phase")) {
    expect(phase.parent_span_id).toBe(tick?.span_id);
  }

  // The seeded issue surfaced as a planned dispatch decision under the same trace.
  expect(events.map((event) => event.name)).toEqual(["score.dispatch.decision"]);
  const decision = events[0];
  expect(decision?.subject).toEqual({ issue_number: SEEDED_ISSUE });
  expect(decision?.attributes?.["score.action"]).toBe("planned");
  expect(decision?.attributes?.trace_id).toBe(traceId);
  expect(decision?.attributes?.["score.dry_run"]).toBe(true);

  // File order is phase-correlated: the dispatch decision precedes the phase
  // spans, and the tick span closes the pass last.
  const order = records.map((record) =>
    record.name === "score.phase"
      ? `phase:${record.attributes?.["score.phase.name"]}`
      : record.name,
  );
  expect(order.indexOf("score.dispatch.decision")).toBeLessThan(
    order.indexOf("phase:cleanup+dispatch"),
  );
  expect(order.at(-1)).toBe("score.tick");
}, 20_000);

test("a JSONL append failure changes no phase result, render output, or phase order", async () => {
  // Both runs share one repo + home: the prose log embeds their paths, so a
  // parity diff is only meaningful over identical fixtures.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedHome(repo);
  const control = await runOnce(repo, home);

  // Make every append fail hard: the telemetry segment path exists as a file,
  // so the writer's mkdir/append can never succeed.
  await rm(join(home, "projects", "demo", "telemetry"), { recursive: true, force: true });
  await writeFile(join(home, "projects", "demo", "telemetry"), "not a directory\n");
  const failing = await runOnce(repo, home);

  // Identical phase behavior: same command sequence, same render and summary
  // lines — only the rate-limited telemetry failure warns differ.
  expect(failing.commands).toEqual(control.commands);
  const stripTelemetry = (lines: readonly LogLine[]) =>
    lines.filter((line) => !line.text.startsWith("telemetry append failed"));
  expect(stripTelemetry(failing.log.logged)).toEqual(stripTelemetry(control.log.logged));

  // Many appends failed (three phase spans, the tick span, every event), but
  // the failure report is rate-limited to one line inside the interval.
  const failureLines = failing.log.logged.filter((line) =>
    line.text.startsWith("telemetry append failed"),
  );
  expect(failureLines).toHaveLength(1);
  // The failure line carries the active span's correlation ids (epic #58).
  expect(failureLines[0]?.text).toMatch(/trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16}/);

  // No segment directory materialized and no record was stored.
  const stats = await stat(join(home, "projects", "demo", "telemetry"));
  expect(stats.isFile()).toBe(true);
}, 20_000);

test("unmanaged discovery mode records nothing — no project key to segment under", async () => {
  const home = await mkdtemp(join(tmpdir(), "score-home-"));
  const saved = process.env.SCORE_HOME;
  process.env.SCORE_HOME = home;
  try {
    const runner = new FakeRunner((command) => {
      if (command[1] === "rev-parse" && command.includes("--abbrev-ref")) return { exitCode: 1 };
      if (command[1] === "rev-parse") return { stdout: "/repos/score\n" };
      if (command[1] === "repo") return { stdout: '{"nameWithOwner":"owner/score"}\n' };
      return {};
    });
    const log = new CaptureLogger();
    // A phase that throws on the empty fake backlog is DaemonService's normal
    // caught-error path; --once still completes the pass and exits cleanly.
    await runDaemonLoop(parseDaemonArguments(["--once", "--dry-run"]), log, undefined, { runner });

    // No project directory — hence no telemetry segments — was ever created.
    expect(
      await stat(join(home, "projects")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.SCORE_HOME;
    else process.env.SCORE_HOME = saved;
  }
});

test("no phase module imports the telemetry log writer; no OTel SDK ships anywhere", async () => {
  const phaseFeatures = ["cleanup", "dispatch", "landing", "repair"] as const;
  for (const feature of phaseFeatures) {
    const dir = new URL(`../../../../packages/core/src/${feature}/`, import.meta.url);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(new URL(name, dir), "utf8");
      expect(source.includes("telemetry")).toBe(false);
    }
  }
  const packageRoot = new URL("../../../../", import.meta.url);
  for (const group of ["", "apps/", "packages/"]) {
    const base = new URL(group, packageRoot);
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name !== "package.json") continue;
      const raw = await readFile(new URL(entry.name, base), "utf8");
      expect(raw.toLowerCase()).not.toContain("opentelemetry");
    }
  }
});
