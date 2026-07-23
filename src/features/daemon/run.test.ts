import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ScoreConfig } from "@/features/config/model";
import { resolveProjects } from "@/features/config/resolve";
import { bootstrapDaemon, parseDaemonArguments } from "@/features/daemon/run";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";

test("daemon flags parse and default to the long-running loop", () => {
  expect(parseDaemonArguments([])).toEqual({
    once: false,
    dryRun: false,
    verbose: false,
    noMerge: false,
    managed: false,
  });
  expect(parseDaemonArguments(["--once", "--dry-run"])).toMatchObject({
    once: true,
    dryRun: true,
  });
});

test("a stray subcommand reaches the daemon as an unknown flag, not a silent no-op", () => {
  expect(() => parseDaemonArguments(["autopilo"])).toThrow("unknown flag: autopilo");
});

test("--project takes a value; --managed and --config require --project", () => {
  expect(parseDaemonArguments(["--project", "demo", "--managed", "--once"])).toMatchObject({
    project: "demo",
    managed: true,
    once: true,
  });
  expect(parseDaemonArguments(["--project", "demo", "--config", "/x/resolved.json"])).toMatchObject(
    { project: "demo", resolvedPath: "/x/resolved.json" },
  );
  expect(() => parseDaemonArguments(["--project"])).toThrow("--project requires a value");
  expect(() => parseDaemonArguments(["--project", "--once"])).toThrow("--project requires a value");
  expect(() => parseDaemonArguments(["--managed"])).toThrow("--managed requires --project");
  expect(() => parseDaemonArguments(["--config", "/x"])).toThrow("--config requires --project");
});

class FakeRunner implements CommandRunner {
  readonly calls: { command: readonly string[]; cwd: string }[] = [];

  constructor(
    private readonly respond: (command: readonly string[]) => {
      exitCode?: number;
      stdout?: string;
    } = () => ({}),
  ) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, cwd: options.cwd });
    const response = this.respond(command);
    return {
      command,
      cwd: options.cwd,
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? "",
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  }
}

async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Writes a valid resolved.json for `demo` under a temp SCORE_HOME and returns both dirs. */
async function managedFixture(mainLocation: string): Promise<{ home: string; worktree: string }> {
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
        config: {
          tick_interval_ms: 5000,
          max_parallel: 2,
          agent: { harness: "claude", model: "claude-sonnet-5" },
        },
      },
    },
  };
  const [project] = resolveProjects(config);
  await mkdir(join(home, "projects", "demo"), { recursive: true });
  await writeFile(join(home, "projects", "demo", "resolved.json"), JSON.stringify(project));
  return { home, worktree };
}

test("managed bootstrap reads resolved.json from SCORE_HOME and ignores env tuning", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home, worktree } = await managedFixture(repo);
  await withEnv(
    { SCORE_HOME: home, TICK_INTERVAL_MS: "999999", MAX_PARALLEL: "9", WORKTREE_ROOT: "/nope" },
    async () => {
      const runner = new FakeRunner((command) => {
        if (command[1] === "rev-parse") return { stdout: `${repo}\n` };
        if (command[1] === "symbolic-ref") return { stdout: "refs/remotes/origin/develop\n" };
        return {};
      });
      const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);
      const boot = await bootstrapDaemon(parsed, runner);

      // worktree_location is the FINAL worktree dir — no <repoName> appended.
      expect(boot.workspaceRoot).toBe(worktree);
      expect(boot.tickIntervalMs).toBe(5000);
      expect(boot.maxParallelIssues).toBe(2);
      expect(boot.managed).toBe(true);
      expect(boot.runtime.repository).toBe("egoisutolabs/demo");
      expect(boot.runtime.repositoryRoot).toBe(repo);
      expect(boot.runtime.defaultBranch).toBe("develop");
      // Every preflight runs inside main_location, so cwd never matters.
      for (const call of runner.calls) expect(call.cwd).toBe(repo);
      expect(runner.calls.map((call) => call.command[0])).toEqual(["git", "gh", "tmux", "git"]);
    },
  );
});

test("managed bootstrap fails when main_location is not the git toplevel", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const subdirectory = join(repo, "packages", "demo");
  await mkdir(subdirectory, { recursive: true });
  const { home } = await managedFixture(subdirectory);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) =>
      command[1] === "rev-parse" ? { stdout: `${repo}\n` } : {},
    );
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /projects\.demo\.main_location .* is not a git toplevel/,
    );
  });
});

test("unmanaged bootstrap keeps discovery and env-first tuning", async () => {
  await withEnv(
    {
      GH_REPO: "owner/score",
      TICK_INTERVAL_MS: "5000",
      MAX_PARALLEL: "3",
      WORKTREE_ROOT: "/tmp/wtroot",
    },
    async () => {
      const runner = new FakeRunner((command) => {
        if (command[1] === "rev-parse") return { stdout: "/repos/score\n" };
        if (command[1] === "symbolic-ref") return { exitCode: 1 };
        return {};
      });
      const boot = await bootstrapDaemon(parseDaemonArguments(["--once"]), runner);

      expect(boot.managed).toBe(false);
      expect(boot.tickIntervalMs).toBe(5000);
      expect(boot.maxParallelIssues).toBe(3);
      expect(boot.workspaceRoot).toBe("/tmp/wtroot/score");
      expect(boot.runtime.defaultBranch).toBe("main");
    },
  );
});
