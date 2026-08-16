import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { LaunchdSupervisor } from "@score/core/supervisor/launchd.service";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runDown, runRestart, runUp, type UpDependencies } from "./supervisor.run";

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];
  listOutput = "";
  /** Per-call `list` outputs, consumed first — models a drain ending mid-run. */
  readonly listQueue: string[] = [];
  failBootstrapMatching: string | undefined;
  failBootoutMatching: string | undefined;
  failKickstartMatching: string | undefined;

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([...command]);
    const matches = (pattern: string | undefined): boolean =>
      pattern !== undefined && command.some((argument) => argument.includes(pattern));
    const failed =
      (command[1] === "bootstrap" && matches(this.failBootstrapMatching)) ||
      (command[1] === "bootout" && matches(this.failBootoutMatching)) ||
      (command[1] === "kickstart" && matches(this.failKickstartMatching));
    return {
      command: [...command],
      cwd: options.cwd,
      exitCode: failed ? 5 : 0,
      stdout: command[1] === "list" ? (this.listQueue.shift() ?? this.listOutput) : "",
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
    sleep: async () => {},
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

function projectBlock(key: string, mainLocation: string, tick: number, enabled = true): string {
  return `"${key}": {
    "enabled": ${enabled},
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

test("single-project up still resolves other configured jobs' checkouts from config", async () => {
  // beta is loaded with unreadable state but IS in config — its location is
  // knowable, so it must not falsely block `up alpha` as an unknown job.
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  runner.listOutput = "2\t0\tdev.score.beta";
  await runUp(["alpha"], deps);
  expect(errors).toEqual([]);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=1 restarted=0 unchanged=0 removed=0");
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

test("restart forces stop→install→start on a loaded-but-unchanged job (TUI `r` parity)", async () => {
  // `up` would report this job unchanged and touch nothing — a crashed or
  // wedged daemon needs the forced path. Same state covers the crashed-job
  // case: still registered, brought back to running.
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.alpha";
  logs = [];

  await runRestart(["alpha"], deps.adapter);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootout", "gui/501/dev.score.alpha"],
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs).toContain("restarted 'alpha'");
});

test("restart with no saved definition fails before any adapter call (read-before-stop)", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await expect(runRestart(["alpha"], deps.adapter)).rejects.toThrow(
    "no saved job definition for 'alpha'",
  );
  expect(runner.calls).toEqual([]);
});

test("restart with an empty (corrupt) saved definition fails before stopping", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  await writeFile(join(home, "projects", "alpha", "job.plist"), "");
  await expect(runRestart(["alpha"], deps.adapter)).rejects.toThrow(
    "no saved job definition for 'alpha'",
  );
  expect(runner.calls).toEqual([]);
});

test("restart refuses a disabled or unknown project before touching the supervisor", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;

  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000, false)]);
  await expect(runRestart(["alpha"], deps.adapter)).rejects.toThrow(
    "no enabled project 'alpha' in config",
  );
  await expect(runRestart(["ghost"], deps.adapter)).rejects.toThrow(
    "no enabled project 'ghost' in config",
  );
  expect(runner.calls).toEqual([]);
});

test("restart requires a key and rejects malformed ones", async () => {
  await expect(runRestart([], deps.adapter)).rejects.toThrow("usage: score restart <key>");
  await expect(runRestart(["../../x"], deps.adapter)).rejects.toThrow("invalid project key");
  expect(runner.calls).toEqual([]);
});

test("restart step failure at stop: job untouched, next up is a no-op (converged)", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.alpha";
  runner.failBootoutMatching = "dev.score.alpha";

  await expect(runRestart(["alpha"], deps.adapter)).rejects.toThrow();
  expect(runner.mutations()).toEqual([["launchctl", "bootout", "gui/501/dev.score.alpha"]]);

  runner.failBootoutMatching = undefined;
  runner.calls.length = 0;
  logs = [];
  await runUp([], deps);
  expect(runner.mutations()).toEqual([]);
  expect(logs.at(-1)).toBe("started=0 restarted=0 unchanged=1 removed=0");
});

test("restart death after stop: next `score up` re-installs and starts (RETRIED)", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.alpha";
  runner.failBootstrapMatching = "dev.score.alpha";

  // A bootstrap failure leaves the same state as a death between stop and
  // install: booted out, definition files intact.
  await expect(runRestart(["alpha"], deps.adapter)).rejects.toThrow();
  expect(runner.mutations().map((call) => call[1])).toEqual(["bootout", "bootstrap"]);

  runner.failBootstrapMatching = undefined;
  runner.calls.length = 0;
  runner.listOutput = "";
  logs = [];
  await runUp([], deps);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=1 restarted=0 unchanged=0 removed=0");
});

test("restart death after install: job registered, a retried restart converges", async () => {
  // install() itself launches the job on both platforms (launchd KeepAlive
  // implies RunAtLoad; systemd enables --now), so this state is not wedged
  // even before the retry.
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.alpha";
  runner.failKickstartMatching = "dev.score.alpha";

  await expect(runRestart(["alpha"], deps.adapter)).rejects.toThrow();
  expect(runner.mutations().map((call) => call[1])).toEqual(["bootout", "bootstrap", "kickstart"]);

  runner.failKickstartMatching = undefined;
  runner.calls.length = 0;
  logs = [];
  await runRestart(["alpha"], deps.adapter);
  expect(runner.mutations().map((call) => call[1])).toEqual(["bootout", "bootstrap", "kickstart"]);
  expect(logs).toContain("restarted 'alpha'");
});

test("restart racing a config-changing up: the lock refuses the interleaving, the next up repairs", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.listOutput = "1\t0\tdev.score.alpha";

  // Interleave a config edit + full `up` between restart's definition read
  // and its stop — the ordering that used to tear the record. The lock
  // restart holds must make the inner up refuse alpha without mutating it.
  const real = deps.adapter;
  let raced = false;
  const racing: typeof real = {
    install: (key, definition) => real.install(key, definition),
    uninstall: (key) => real.uninstall(key),
    start: (key) => real.start(key),
    status: () => real.status(),
    stop: async (key) => {
      if (!raced) {
        raced = true;
        await writeConfig([projectBlock("alpha", "/repos/alpha2", 5000)]);
        await runUp([], deps);
      }
      await real.stop(key);
    },
  };
  await runRestart(["alpha"], racing);
  expect(errors.some((line) => line.includes("failed to restart 'alpha'"))).toBe(true);
  expect(errors.some((line) => line.includes("is being modified by pid"))).toBe(true);
  expect(await readFile(join(agentsDir, "dev.score.alpha.plist"), "utf8")).not.toContain(
    "/repos/alpha2",
  );

  // The interleaved up never applied, so the next up still sees the config
  // change and repairs — no torn state survives.
  runner.calls.length = 0;
  logs = [];
  await runUp([], deps);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootout", "gui/501/dev.score.alpha"],
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=0 restarted=1 unchanged=0 removed=0");
  expect(await readFile(join(agentsDir, "dev.score.alpha.plist"), "utf8")).toContain(
    "/repos/alpha2",
  );
});

test("a live holder's lock blocks restart, up, and down without touching the supervisor", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.alpha";
  // This test process holds the lock — a provably live pid.
  await writeFile(join(home, "projects", "alpha.mutate.lock"), String(process.pid));

  await expect(runRestart(["alpha"], deps.adapter)).rejects.toThrow("is being modified by pid");
  expect(runner.mutations()).toEqual([]);

  errors = [];
  await writeConfig([projectBlock("alpha", "/repos/alpha", 9000)]);
  await runUp([], deps);
  expect(errors.some((line) => line.includes("is being modified by pid"))).toBe(true);
  expect(runner.mutations()).toEqual([]);

  // down is serialized by the same lock: while an up converges the project
  // (e.g. waiting out a teardown drain), a concurrent down must refuse
  // loudly instead of reporting "stopped" and then losing to the install.
  errors = [];
  await runDown(["alpha"], deps.adapter);
  expect(errors.some((line) => line.includes("failed to stop 'alpha'"))).toBe(true);
  expect(errors.some((line) => line.includes("is being modified by pid"))).toBe(true);
  expect(runner.mutations()).toEqual([]);
  expect(process.exitCode).toBe(1);
});

test("a stale lock (dead holder or garbage) is broken and the command proceeds", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.calls.length = 0;
  runner.listOutput = "1\t0\tdev.score.alpha";
  logs = [];
  const lockPath = join(home, "projects", "alpha.mutate.lock");

  await writeFile(lockPath, "not-a-pid");
  await runRestart(["alpha"], deps.adapter);
  expect(logs).toContain("restarted 'alpha'");

  const dead = spawnSync("true").pid;
  await writeFile(lockPath, String(dead));
  logs = [];
  await runRestart(["alpha"], deps.adapter);
  expect(logs).toContain("restarted 'alpha'");
  // The lock is released afterwards, not left behind.
  await expect(readFile(lockPath, "utf8")).rejects.toThrow();
});

test("a deregistered job with its definition kept: `up` re-installs and starts (TUI start parity)", async () => {
  await writeConfig([
    projectBlock("alpha", "/repos/alpha", 5000),
    projectBlock("beta", "/repos/beta", 7000),
  ]);
  await runUp([], deps);
  runner.calls.length = 0;
  // alpha booted out (definition-only), beta still loaded.
  runner.listOutput = "2\t0\tdev.score.beta";
  logs = [];

  await runUp([], deps);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=1 restarted=0 unchanged=1 removed=0");
});

test("down then keyed up during the bootout drain waits it out and starts (#93)", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.listOutput = "1\t0\tdev.score.alpha";
  await runDown(["alpha"], deps.adapter);
  // launchd's bootout is asynchronous: the booted-out job stays listed (plist
  // gone) at plan time and for the first wait poll, then the process exits.
  runner.listQueue.push("1\t0\tdev.score.alpha", "1\t0\tdev.score.alpha");
  runner.listOutput = "";
  runner.calls.length = 0;
  logs = [];

  await runUp(["alpha"], deps);
  expect(logs).toContain("'alpha' is still stopping — waiting for the old process to exit");
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=1 restarted=0 unchanged=0 removed=0");
  expect(errors).toEqual([]);
});

test("a drain outlasting the wait fails loudly with nothing mutated; the next up converges (RETRIED)", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.listOutput = "1\t0\tdev.score.alpha";
  await runDown(["alpha"], deps.adapter);
  // The drain never ends: every status call keeps showing the booted-out job.
  runner.calls.length = 0;
  logs = [];

  await runUp(["alpha"], deps);
  expect(
    errors.some((line) => line.includes("failed to start 'alpha'") && line.includes("stopping")),
  ).toBe(true);
  expect(runner.mutations()).toEqual([]);
  expect(process.exitCode).toBe(1);

  // The wait mutated nothing, so once the process exits the retried command
  // converges to a running job.
  process.exitCode = 0;
  runner.listOutput = "";
  runner.calls.length = 0;
  logs = [];
  errors = [];
  await runUp(["alpha"], deps);
  expect(runner.mutations()).toEqual([
    ["launchctl", "bootstrap", "gui/501", join(agentsDir, "dev.score.alpha.plist")],
    ["launchctl", "kickstart", "gui/501/dev.score.alpha"],
  ]);
  expect(logs.at(-1)).toBe("started=1 restarted=0 unchanged=0 removed=0");
});

test("a job re-registered while up waits fails fast without mutating, not the full timeout", async () => {
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runUp([], deps);
  runner.listOutput = "1\t0\tdev.score.alpha";
  await runDown(["alpha"], deps.adapter);
  // The old pid stays listed throughout, but a concurrent command re-installs
  // the plist right after the plan's status snapshot. The wait must read that
  // as "this plan is stale" and refuse before any mutation — installing over
  // the live registration would tear plist and record apart.
  const real = deps.adapter;
  let statusCalls = 0;
  const racing: typeof real = {
    install: (key, definition) => real.install(key, definition),
    uninstall: (key) => real.uninstall(key),
    start: (key) => real.start(key),
    stop: (key) => real.stop(key),
    status: async () => {
      statusCalls++;
      if (statusCalls === 2) await writeFile(join(agentsDir, "dev.score.alpha.plist"), "<plist/>");
      return real.status();
    },
  };
  runner.calls.length = 0;
  logs = [];
  await runUp(["alpha"], { ...deps, adapter: racing });
  expect(errors.filter((line) => line.includes("still stopping"))).toEqual([]);
  expect(errors.some((line) => line.includes("re-registered by a concurrent command"))).toBe(true);
  expect(runner.mutations()).toEqual([]);
  expect(process.exitCode).toBe(1);
});

test("down of a key with no project state leaves no empty state dir behind (#99 review)", async () => {
  // /readyz reads every project dir as a project that must carry a parseable
  // resolved.json — an empty dir left by down's lock would wedge readiness.
  await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
  await runDown(["ghost"], deps.adapter);
  expect(logs).toContain("stopped 'ghost'");
  await expect(stat(join(home, "projects", "ghost"))).rejects.toThrow();
});

// Root ignores file modes, so the EACCES this test relies on never fires there.
test.skipIf(process.getuid?.() === 0)(
  "an unreadable lock file fails promptly instead of retrying forever",
  async () => {
    await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
    await runUp([], deps);
    runner.calls.length = 0;
    runner.listOutput = "1\t0\tdev.score.alpha";
    const lockPath = join(home, "projects", "alpha.mutate.lock");
    await writeFile(lockPath, "whatever");
    // Mode 000: creation reports EEXIST, every read reports EACCES — that
    // must surface, not loop forever.
    await chmod(lockPath, 0o000);
    try {
      await runDown(["alpha"], deps.adapter);
    } finally {
      await chmod(lockPath, 0o644);
    }
    expect(errors.some((line) => line.includes("failed to stop 'alpha'"))).toBe(true);
    expect(runner.mutations()).toEqual([]);
    expect(process.exitCode).toBe(1);
  },
);

// Root ignores file modes, so the EACCES this test relies on never fires there.
test.skipIf(process.getuid?.() === 0)(
  "a stale lock that cannot be reclaimed (read-only store) fails promptly instead of spinning",
  async () => {
    await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
    await runUp([], deps);
    runner.calls.length = 0;
    runner.listOutput = "1\t0\tdev.score.alpha";
    // A dead-holder lock exists, but the store is read-only: creation reports
    // EEXIST while every reclaim rename reports EACCES — that must surface,
    // not loop forever.
    await writeFile(join(home, "projects", "alpha.mutate.lock"), "not-a-pid");
    await chmod(join(home, "projects"), 0o555);
    try {
      await runDown(["alpha"], deps.adapter);
    } finally {
      await chmod(join(home, "projects"), 0o755);
    }
    expect(errors.some((line) => line.includes("failed to stop 'alpha'"))).toBe(true);
    expect(runner.mutations()).toEqual([]);
    expect(process.exitCode).toBe(1);
  },
);

// Root ignores file modes, so the EACCES this test relies on never fires there.
test.skipIf(process.getuid?.() === 0)(
  "an uncreatable lock fails down promptly instead of spinning",
  async () => {
    await writeConfig([projectBlock("alpha", "/repos/alpha", 5000)]);
    await runUp([], deps);
    runner.calls.length = 0;
    runner.listOutput = "1\t0\tdev.score.alpha";
    // The lock lives in the projects root — make that unwritable.
    await chmod(join(home, "projects"), 0o555);
    try {
      await runDown(["alpha"], deps.adapter);
    } finally {
      await chmod(join(home, "projects"), 0o755);
    }
    expect(errors.some((line) => line.includes("failed to stop 'alpha'"))).toBe(true);
    expect(runner.mutations()).toEqual([]);
    expect(process.exitCode).toBe(1);
  },
);

test("no lifecycle HTTP route: web/server sources touching routes or fetch carry no lifecycle verbs", async () => {
  // The control half of decision 6/7 (#58): lifecycle authority stays in the
  // CLI/supervisor path, so no HTTP-facing app may install/start/stop jobs.
  const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
  const offenders: string[] = [];
  for (const app of ["server", "web"]) {
    // A missing app is vacuously clean.
    const entries = await readdir(join(repoRoot, "apps", app), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      const path = join(entry.parentPath, entry.name);
      if (path.includes(`${sep}node_modules${sep}`)) continue;
      const source = await readFile(path, "utf8");
      // Import boundary first: a route can hide lifecycle calls behind a
      // helper, but the helper still has to import the supervisor feature
      // or the TUI actions from somewhere in the app.
      const importsLifecycle =
        /from\s+["'](@score\/core\/supervisor|@score\/tui|@egoisutolabs\/score)/.test(source) ||
        /\bsupervisor-adapter|launchd\.service|systemd\.service|supervisor\.run\b/.test(source);
      const routeWithVerbs =
        /route|fetch/i.test(source) &&
        /\b(install|uninstall|start|stop|restart|kickstart|bootout|bootstrap)\b/i.test(source);
      if (importsLifecycle || routeWithVerbs) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
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
