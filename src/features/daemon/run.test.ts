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

function managedResponses(repo: string) {
  return (command: readonly string[]): { exitCode?: number; stdout?: string } => {
    if (command[1] === "rev-parse") return { stdout: `${repo}\n` };
    if (command[1] === "remote") return { stdout: "git@github.com:egoisutolabs/demo.git\n" };
    if (command[1] === "config") return { exitCode: 1 };
    if (command[1] === "repo") return { stdout: '{"nameWithOwner":"egoisutolabs/demo"}\n' };
    // No tmux server running yet: the env scrub fails and that must be fine.
    if (command[1] === "set-environment") return { exitCode: 1 };
    if (command[1] === "symbolic-ref") return { stdout: "refs/remotes/origin/develop\n" };
    return {};
  };
}

test("managed bootstrap reads resolved.json from SCORE_HOME and ignores env tuning", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home, worktree } = await managedFixture(repo);
  await withEnv(
    {
      SCORE_HOME: home,
      TICK_INTERVAL_MS: "999999",
      MAX_PARALLEL: "9",
      WORKTREE_ROOT: "/nope",
      GH_REPO: "someone/else",
    },
    async () => {
      const runner = new FakeRunner(managedResponses(repo));
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
      // GH_REPO would redirect every later cwd-scoped gh call; managed mode
      // clears it so gh only ever sees the verified checkout.
      expect(process.env.GH_REPO).toBeUndefined();
      // Every preflight runs inside main_location, so cwd never matters.
      for (const call of runner.calls) expect(call.cwd).toBe(repo);
      expect(runner.calls.map((call) => call.command[0])).toEqual([
        "git",
        "git",
        "git",
        "git",
        "gh",
        "gh",
        "tmux",
        "tmux",
        "git",
      ]);
    },
  );
});

test("managed bootstrap fails when github_repo does not match the checkout's origin", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "rev-parse") return { stdout: `${repo}\n` };
      if (command[1] === "remote") return { stdout: "https://github.com/someone/else.git\n" };
      return {};
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /projects\.demo\.github_repo egoisutolabs\/demo does not match origin https:\/\/github\.com\/someone\/else\.git/,
    );
  });
});

test("managed bootstrap fails when the push URL diverges from github_repo", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "remote" && command.includes("--push")) {
        return { stdout: "git@github.com:someone/fork.git\n" };
      }
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /does not match origin push URL git@github\.com:someone\/fork\.git/,
    );
  });
});

test("managed bootstrap fails when any extra push URL points elsewhere", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "remote" && command.includes("--push")) {
        return {
          stdout: "git@github.com:egoisutolabs/demo.git\ngit@github.com:someone/mirror.git\n",
        };
      }
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /does not match origin push URL git@github\.com:someone\/mirror\.git/,
    );
  });
});

test("managed bootstrap fails when gh resolves the checkout to another repo", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "repo") return { stdout: '{"nameWithOwner":"someone/upstream"}\n' };
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /gh resolves .* to someone\/upstream, not projects\.demo\.github_repo egoisutolabs\/demo/,
    );
  });
});

test("managed bootstrap fails when gh repo set-default points away from origin", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "config") return { stdout: "remote.upstream.gh-resolved base\n" };
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /gh repo set-default .* points away from origin/,
    );
  });
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
