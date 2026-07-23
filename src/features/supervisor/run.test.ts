import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LaunchdSupervisor } from "@/features/supervisor/launchd";
import { runDown, runUp, type UpDependencies } from "@/features/supervisor/run";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];
  listOutput = "";
  failBootstrapMatching: string | undefined;
  failBootoutMatching: string | undefined;

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([...command]);
    const matches = (pattern: string | undefined): boolean =>
      pattern !== undefined && command.some((argument) => argument.includes(pattern));
    const failed =
      (command[1] === "bootstrap" && matches(this.failBootstrapMatching)) ||
      (command[1] === "bootout" && matches(this.failBootoutMatching));
    return {
      command: [...command],
      cwd: options.cwd,
      exitCode: failed ? 5 : 0,
      stdout: command[1] === "list" ? this.listOutput : "",
      stderr: failed ? "Bootstrap failed: 5: Input/output error" : "",
      timedOut: false,
      dryRun: false,
    };
  }

  mutations(): string[][] {
    return this.calls.filter((call) => call[1] !== "list");
  }
}

const originalScoreHome = process.env.SCORE_HOME;
let home: string;
let agentsDir: string;
let runner: RecordingRunner;
let deps: UpDependencies;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "score-up-"));
  home = join(root, "state");
  agentsDir = join(root, "LaunchAgents");
  process.env.SCORE_HOME = home;
  runner = new RecordingRunner();
  deps = {
    adapter: new LaunchdSupervisor(runner, { uid: 501, launchAgentsDir: agentsDir }),
    invocationFor: (key) => [
      "/bin/bun",
      "/opt/score/dist/index.js",
      "daemon",
      "--project",
      key,
      "--managed",
    ],
  };
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => errors.push(line));
});

afterEach(() => {
  if (originalScoreHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = originalScoreHome;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function projectBlock(key: string, mainLocation: string, tick: number): string {
  return `"${key}": {
    "enabled": true,
    "main_location": "${mainLocation}",
    "worktree_location": "/wt/${key}",
    "github_repo": "egoisutolabs/${key}",
    "config": {
      "tick_interval_ms": ${tick},
      "agent": { "harness": "claude", "model": "claude-sonnet-5" }
    }
  }`;
}

async function writeConfig(projects: string[], comment = "supervisor test"): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.jsonc"),
    `{
  // ${comment}
  "version": 1,
  "projects": { ${projects.join(",\n")} }
}`,
  );
}

const bothLoaded = "1\t0\tdev.score.alpha\n2\t0\tdev.score.beta";

test("fresh up: writes resolved.json, renders plists, bootstraps and reports started=2", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);

  for (const key of ["alpha", "beta"]) {
    const resolved = JSON.parse(
      await readFile(join(home, "projects", key, "resolved.json"), "utf8"),
    );
    expect(resolved.key).toBe(key);
    expect(typeof resolved.configHash).toBe("string");
  }
  expect((await readdir(agentsDir)).sort()).toEqual([
    "dev.score.alpha.plist",
    "dev.score.beta.plist",
  ]);
  const alphaPlist = await readFile(join(agentsDir, "dev.score.alpha.plist"), "utf8");
  expect(alphaPlist).toContain("<string>--project</string>");
  expect(alphaPlist).toContain("<string>alpha</string>");
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.beta.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.beta"],
  ]);
  expect(logs.at(-1)).toBe("started=2 restarted=0 unchanged=0 removed=0");
});

test("second up with no config change performs zero launchctl mutations", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = bothLoaded;
  logs = [];

  await runUp([], deps);
  expect(runner.mutations()).toEqual([]);
  expect(logs.at(-1)).toBe("started=0 restarted=0 unchanged=2 removed=0");
});

test("a comment-only config edit stays unchanged (hash over resolved values)", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = bothLoaded;
  logs = [];

  await writeConfig(
    [projectBlock("alpha", "/repos/alpha", 5000), projectBlock("beta", "/repos/beta", 7000)],
    "different comment, same values",
  );
  await runUp([], deps);
  expect(runner.mutations()).toEqual([]);
  expect(logs.at(-1)).toBe("started=0 restarted=0 unchanged=2 removed=0");
});

test("changing one project's tick_interval_ms restarts that project alone", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = bothLoaded;
  logs = [];

  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 9000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootout", "gui/501/dev.score.alpha"],
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  const resolved = JSON.parse(
    await readFile(join(home, "projects", "alpha", "resolved.json"), "utf8"),
  );
  expect(resolved.tickIntervalMs).toBe(9000);
  expect(logs.at(-1)).toBe("started=0 restarted=1 unchanged=1 removed=0");
});

test("rename a→b on one checkout: b refused with the exact down command, nothing started", async () => {
  await writeConfig([projectBlock("a", "/repos/shared", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.a";
  logs = [];

  await writeConfig([projectBlock("b", "/repos/shared", 5000)]);
  await runUp([], deps);
  expect(errors).toEqual([
    "refusing to start 'b': dev.score.a already supervises /repos/shared — run: score down a",
  ]);
  expect(runner.mutations()).toEqual([]);
  expect(logs.at(-1)).toBe("started=0 restarted=0 unchanged=0 removed=1");
  expect(process.exitCode).toBe(1);
});

test("partial failure: one bootstrap fails, the other project still starts, exit non-zero", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  runner.failBootstrapMatching = "dev.score.beta";
  await runUp([], deps);
  expect(logs.at(-1)).toBe("started=1 restarted=0 unchanged=0 removed=0");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("failed to start 'beta'");
  expect(process.exitCode).toBe(1);
  expect(runner.mutations()).toContainEqual(["launchctl", "kickstart", "gui/501/dev.score.alpha"]);
});

test("single-project up only reconciles that key and reports no removals", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = bothLoaded;
  logs = [];

  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 9000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp(["alpha"], deps);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootout", "gui/501/dev.score.alpha"],
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=0 restarted=1 unchanged=0 removed=0");
  await expect(runUp(["missing"], deps)).rejects.toThrow("no enabled project 'missing'");
});

test("a loaded job with no readable state blocks new starts (fail closed)", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  runner.listOutput = "1\t0\tdev.score.ghost";
  await runUp([], deps);
  expect(errors).toEqual([
    "refusing to start 'alpha': dev.score.ghost is running with unreadable state, which could be this checkout — run: score down ghost",
  ]);
  expect(runner.mutations()).toEqual([]);
  expect(process.exitCode).toBe(1);
});

test("a drifted rendered definition restarts a job even when the hash is unchanged", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.alpha";
  logs = [];

  const moved: UpDependencies = {
    adapter: deps.adapter,
    invocationFor: (key) => [
      "/bin/bun",
      "/new/home/dist/index.js",
      "daemon",
      "--project",
      key,
      "--managed",
    ],
  };
  await runUp([], moved);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootout", "gui/501/dev.score.alpha"],
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=0 restarted=1 unchanged=0 removed=0");
  expect(await readFile(join(agentsDir, "dev.score.alpha.plist"), "utf8")).toContain(
    "/new/home/dist/index.js",
  );
});

test("keys with path separators or dots are rejected before reaching the adapter", async () => {
  await expect(runDown(["../../foo"], deps.adapter)).rejects.toThrow("invalid project key");
  await expect(runDown(["dev.score.a"], deps.adapter)).rejects.toThrow("invalid project key");
  expect(runner.calls).toEqual([]);
});

test("invalid config touches nothing", async () => {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.jsonc"), `{ "version": 2, "projects": {} }`);
  await expect(runUp([], deps)).rejects.toThrow("config.version must be 1");
  expect(runner.calls).toEqual([]);
});

test("down <key> boots out, removes the plist, and keeps the state dir", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;

  await runDown(["beta"], deps.adapter);
  expect(runner.mutations()).toEqual([["launchctl", "bootout", "gui/501/dev.score.beta"]]);
  expect((await readdir(agentsDir)).sort()).toEqual(["dev.score.alpha.plist"]);
  expect((await stat(join(home, "projects", "beta"))).isDirectory()).toBe(true);
});

test("down continues past a failing job and reports it", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = bothLoaded;
  runner.failBootoutMatching = "dev.score.alpha";

  await runDown([], deps.adapter);
  expect(logs).toContain("stopped 'beta'");
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("failed to stop 'alpha'");
  expect(process.exitCode).toBe(1);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootout", "gui/501/dev.score.alpha"],
    ["launchctl", "bootout", "gui/501/dev.score.beta"],
  ]);
});

test("down with no argument stops all score jobs and nothing else", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = `${bothLoaded}\n3\t0\tcom.apple.other`;

  await runDown([], deps.adapter);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootout", "gui/501/dev.score.alpha"],
    ["launchctl", "bootout", "gui/501/dev.score.beta"],
  ]);
  expect(await readdir(agentsDir)).toEqual([]);
});
