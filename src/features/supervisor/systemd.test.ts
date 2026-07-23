import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ResolvedProject } from "@/features/config/model";
import { supervisorForPlatform } from "@/features/supervisor/adapter";
import { LaunchdSupervisor } from "@/features/supervisor/launchd";
import { renderUnit, SystemdSupervisor, unitName } from "@/features/supervisor/systemd";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly cwds: string[] = [];
  showOutput = "";
  exitCodeFor: (command: readonly string[]) => number = () => 0;

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([...command]);
    this.cwds.push(options.cwd);
    return {
      command: [...command],
      cwd: options.cwd,
      exitCode: this.exitCodeFor(command),
      stdout: command[2] === "show" ? this.showOutput : "",
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  }
}

const originalScoreHome = process.env.SCORE_HOME;
let runner: RecordingRunner;
let unitDir: string;
let adapter: SystemdSupervisor;

beforeEach(async () => {
  runner = new RecordingRunner();
  unitDir = await mkdtemp(join(tmpdir(), "score-systemd-"));
  adapter = new SystemdSupervisor(runner, { unitDir });
});

afterEach(() => {
  if (originalScoreHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = originalScoreHome;
});

const project: ResolvedProject = {
  key: "demo",
  mainLocation: "/Repos/My 100% Project",
  worktreeLocation: "/wt/demo",
  githubRepo: "egoisutolabs/demo",
  tickIntervalMs: 5000,
  maxParallel: 1,
  agent: { harness: "claude", model: "claude-sonnet-5" },
  autoMerge: true,
  logRetentionDays: 30,
  configHash: "abc",
};

test("unitName namespaces keys", () => {
  expect(unitName("demo")).toBe("score-demo.service");
});

test("renderUnit snapshot, systemd-escaping % specifiers and quoting argv", () => {
  process.env.SCORE_HOME = "/tmp/score 100% home";
  const invocation = [
    "/usr/local/bin/bun",
    "/opt/score tools/dist/index.js",
    "daemon",
    "--project",
    "demo",
    "--managed",
  ];
  const environment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    SCORE_HOME: "/tmp/score 100% home",
  };
  expect(
    renderUnit(project, invocation, environment),
  ).toBe(`# Survives logout only with lingering enabled: loginctl enable-linger $USER
[Unit]
Description=score daemon (demo)

[Service]
ExecStart="/usr/local/bin/bun" "/opt/score tools/dist/index.js" "daemon" "--project" "demo" "--managed"
WorkingDirectory=/Repos/My 100%% Project
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Environment="SCORE_HOME=/tmp/score 100%% home"
Restart=on-failure
RestartSec=10
TimeoutStopSec=600
StandardOutput=append:/tmp/score 100%% home/projects/demo/launchd-crash.log
StandardError=append:/tmp/score 100%% home/projects/demo/launchd-crash.log

[Install]
WantedBy=default.target
`);
});

test("renderUnit omits Environment lines when none are given", () => {
  process.env.SCORE_HOME = "/tmp/x";
  expect(renderUnit(project, ["/bin/bun"])).not.toContain("Environment=");
});

test("install writes the unit, reloads, and enables --now", async () => {
  await adapter.install("demo", "[Unit]\n");
  expect(await readFile(join(unitDir, "score-demo.service"), "utf8")).toBe("[Unit]\n");
  expect(runner.calls).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "score-demo.service"],
  ]);
});

test("start starts the unit", async () => {
  await adapter.start("demo");
  expect(runner.calls).toEqual([["systemctl", "--user", "start", "score-demo.service"]]);
});

test("stop tolerates a unit that is not loaded (exit 5)", async () => {
  runner.exitCodeFor = () => 5;
  await adapter.stop("demo");
  expect(runner.calls).toEqual([["systemctl", "--user", "stop", "score-demo.service"]]);
});

test("stop surfaces other systemctl failures", async () => {
  runner.exitCodeFor = () => 1;
  await expect(adapter.stop("demo")).rejects.toThrow("exited 1");
});

test("uninstall disables --now and removes the unit, and is idempotent", async () => {
  await writeFile(join(unitDir, "score-demo.service"), "[Unit]\n");
  await adapter.uninstall("demo");
  expect(await readdir(unitDir)).toEqual([]);
  expect(runner.calls).toEqual([["systemctl", "--user", "disable", "--now", "score-demo.service"]]);
  // Second uninstall: systemd no longer knows the unit; the failure is tolerated.
  runner.exitCodeFor = () => 1;
  await adapter.uninstall("demo");
});

test("uninstall surfaces disable failures while the unit file still exists", async () => {
  await writeFile(join(unitDir, "score-demo.service"), "[Unit]\n");
  runner.exitCodeFor = () => 1;
  await expect(adapter.uninstall("demo")).rejects.toThrow("exited 1");
  expect(await readdir(unitDir)).toEqual(["score-demo.service"]);
});

test("status parses `show` blocks: running, crashed, stopped, unknown-to-systemd", async () => {
  await writeFile(join(unitDir, "score-alpha.service"), "");
  await writeFile(join(unitDir, "score-beta.service"), "");
  await writeFile(join(unitDir, "score-gamma.service"), "");
  await writeFile(join(unitDir, "score-stale.service"), "");
  await writeFile(join(unitDir, "other.service"), "");
  await writeFile(join(unitDir, "score-not-a-unit.txt"), "");
  runner.showOutput = [
    "Id=score-alpha.service\nActiveState=active\nMainPID=123",
    "Id=score-beta.service\nActiveState=activating\nMainPID=0",
    "Id=score-gamma.service\nActiveState=inactive\nMainPID=0",
    "Id=score-stale.service\nActiveState=inactive\nMainPID=0",
  ].join("\n\n");
  const status = await adapter.status();
  expect(status).toEqual([
    { key: "alpha", loaded: true, pid: 123 },
    { key: "beta", loaded: true },
    { key: "gamma", loaded: false },
    { key: "stale", loaded: false },
  ]);
  expect(runner.calls).toEqual([
    [
      "systemctl",
      "--user",
      "show",
      "--property=Id,ActiveState,MainPID",
      "score-alpha.service",
      "score-beta.service",
      "score-gamma.service",
      "score-stale.service",
    ],
  ]);
});

test("a failed unit (restart limit hit) reads as loaded with no pid — crashed", async () => {
  await writeFile(join(unitDir, "score-alpha.service"), "");
  runner.showOutput = "Id=score-alpha.service\nActiveState=failed\nMainPID=0";
  expect(await adapter.status()).toEqual([{ key: "alpha", loaded: true }]);
});

test("systemctl never runs from the unit dir — it may not exist before install", async () => {
  const missing = new SystemdSupervisor(runner, { unitDir: join(unitDir, "does-not-exist") });
  expect(await missing.status()).toEqual([]);
  await missing.stop("demo");
  await missing.uninstall("demo");
  expect(runner.cwds.every((cwd) => cwd === "/")).toBe(true);
});

test("factory selects launchd on darwin, systemd on linux", () => {
  expect(supervisorForPlatform(runner, "darwin").adapter).toBeInstanceOf(LaunchdSupervisor);
  expect(supervisorForPlatform(runner, "linux").adapter).toBeInstanceOf(SystemdSupervisor);
});

test("factory rejects unsupported platforms before anything runs or is written", () => {
  expect(() => supervisorForPlatform(runner, "win32")).toThrow(
    "score supervisor supports macOS (launchd) and Linux (systemd) — got win32",
  );
  expect(runner.calls).toEqual([]);
});
