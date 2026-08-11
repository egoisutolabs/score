import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeServerHandle } from "@score/agents/opencode-server.service";
import { GitService } from "@score/core/adapters/git.service";
import { StatusWriter } from "@score/core/daemon/status.service";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import type { AgentConfig, ScoreConfig } from "@score/shared/config/config.interface";
import { resolveProjects } from "@score/shared/config/resolve";
import { createFileLogger } from "@score/shared/file-log";
import type { Logger, LogLine } from "@score/shared/log";
import { expect, test } from "vitest";
import {
  bootstrapDaemon,
  parseDaemonArguments,
  runDaemon,
  runDaemonLoop,
  selfHealStagedMerge,
} from "./daemon.run";

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
  readonly calls: {
    command: readonly string[];
    cwd: string;
    mutates: boolean | undefined;
    dryRun: boolean | undefined;
  }[] = [];

  constructor(
    private readonly respond: (command: readonly string[]) => {
      exitCode?: number;
      stdout?: string;
    } = () => ({}),
  ) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({
      command,
      cwd: options.cwd,
      mutates: options.mutates,
      dryRun: options.dryRun,
    });
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
async function managedFixture(
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
        config: {
          tick_interval_ms: 5000,
          max_parallel: 2,
          agent,
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
    if (command[1] === "rev-parse" && command.includes("--abbrev-ref")) {
      return { stdout: "origin/develop\n" };
    }
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

/** Same git/gh proofs as managedResponses, plus empty issue/PR lists so every
 * phase's gh JSON parsing succeeds with zero candidates instead of erroring. */
function managedResponsesOpencode(repo: string) {
  const base = managedResponses(repo);
  return (command: readonly string[]): { exitCode?: number; stdout?: string } => {
    if (command[0] === "gh" && (command[1] === "issue" || command[1] === "pr")) {
      return { stdout: "[]\n" };
    }
    return base(command);
  };
}

test("a separator-bearing --project key is rejected before any state path is built", async () => {
  // logsDir/statusPath join the key under $SCORE_HOME/projects; a traversal
  // key must die before the managed runtime constructs logger or status paths.
  await expect(runDaemon(["--project", "../../escape", "--managed"])).rejects.toThrow(
    "--project must match",
  );
  await expect(runDaemon(["--project", "a/b"])).rejects.toThrow("--project must match");
});

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
      // Namespace, agent, and durable prompt home flow out of resolved.json.
      expect(boot.namespace).toBe("demo");
      expect(boot.agent).toEqual({ harness: "claude", model: "claude-sonnet-5" });
      expect(boot.promptsDir).toBe(join(home, "projects", "demo", "prompts"));
      expect(boot.runtime.repository).toBe("egoisutolabs/demo");
      expect(boot.runtime.repositoryRoot).toBe(repo);
      expect(boot.runtime.defaultBranch).toBe("develop");
      // GH_REPO would redirect every later cwd-scoped gh call; managed mode
      // clears it so gh only ever sees the verified checkout.
      expect(process.env.GH_REPO).toBeUndefined();
      // Every preflight runs inside main_location, so cwd never matters.
      for (const call of runner.calls) expect(call.cwd).toBe(repo);
      // The tmux env scrub mutates a live server, so it must carry the
      // dry-run mutation gate BunCommandRunner short-circuits on.
      const scrub = runner.calls.find((call) => call.command[1] === "set-environment");
      expect(scrub).toMatchObject({ mutates: true, dryRun: true });
      // Read-only preflights must NOT be gated, or dry-run could not verify.
      for (const call of runner.calls.filter((c) => c.command[1] !== "set-environment")) {
        expect(call.mutates).toBeUndefined();
      }
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

test("managed bootstrap rejects github.com as a path segment on a foreign host", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "remote" && command.includes("--push")) {
        return { stdout: "https://gitlab.com/github.com/egoisutolabs/demo.git\n" };
      }
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /does not match origin push URL https:\/\/gitlab\.com\/github\.com\/egoisutolabs\/demo\.git/,
    );
  });
});

test("managed bootstrap fails when the default branch tracks a non-origin upstream", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "rev-parse" && command.includes("--abbrev-ref")) {
        return { stdout: "fork/develop\n" };
      }
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /default branch develop .* must track origin\/develop \(found fork\/develop\)/,
    );
  });
});

test("managed bootstrap fails when a push URL is the same repo path on another host", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[1] === "remote" && command.includes("--push")) {
        // Same owner/repo path, different host — a mirror, not the repo.
        return { stdout: "git@gitlab.com:egoisutolabs/demo.git\n" };
      }
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(
      /does not match origin push URL git@gitlab\.com:egoisutolabs\/demo\.git/,
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

test("managed opencode bootstrap preflights opencode --version and skips tmux entirely", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner(managedResponses(repo));
    const parsed = parseDaemonArguments(["--project", "demo"]);
    const boot = await bootstrapDaemon(parsed, runner);

    expect(boot.agent).toEqual({ harness: "opencode", model: "anthropic/claude-sonnet-5" });
    // A FakeRunner proves no tmux argv is ever issued for this harness.
    expect(runner.calls.some((call) => call.command[0] === "tmux")).toBe(false);
    expect(
      runner.calls.some(
        (call) => call.command[0] === "opencode" && call.command[1] === "--version",
      ),
    ).toBe(true);
  });
});

test("OPENCODE_SERVER_PASSWORD fails bootstrap before any opencode call, naming the variable", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  await withEnv({ SCORE_HOME: home, OPENCODE_SERVER_PASSWORD: "secret" }, async () => {
    const runner = new FakeRunner(managedResponses(repo));
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(/OPENCODE_SERVER_PASSWORD/);
    expect(runner.calls.some((call) => call.command[0] === "opencode")).toBe(false);
  });
});

/** Records every request a fake `opencode serve` receives. */
async function startFakeOpencodeServer(): Promise<{
  baseUrl: string;
  requests: { method: string; path: string }[];
  close: () => void;
}> {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method ?? "GET", path: url.pathname });
    if (url.pathname === "/api/session") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], cursor: {} }));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => server.close(),
  };
}

async function runOpencodeLoop(dryRun: boolean): Promise<{
  startCalls: number;
  stopCalls: number;
  requests: { method: string; path: string }[];
}> {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  let result!: {
    startCalls: number;
    stopCalls: number;
    requests: { method: string; path: string }[];
  };
  await withEnv({ SCORE_HOME: home }, async () => {
    const stub = await startFakeOpencodeServer();
    try {
      let startCalls = 0;
      let stopCalls = 0;
      const handle: OpencodeServerHandle = {
        baseUrl: stub.baseUrl,
        // Never resolves: these runs settle via --once, not a child exit.
        unexpectedExit: new Promise(() => {}),
        stop: async () => {
          stopCalls++;
        },
      };
      const startOpencodeServer = async (): Promise<OpencodeServerHandle> => {
        startCalls++;
        return handle;
      };

      const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
      const fileLog = createFileLogger(join(runsDir, "logs"), false);
      const status = new StatusWriter(join(runsDir, "status.json"));
      const runner = new FakeRunner(managedResponsesOpencode(repo));
      const args = dryRun
        ? ["--project", "demo", "--once", "--dry-run"]
        : ["--project", "demo", "--once"];
      const parsed = parseDaemonArguments(args);

      await runDaemonLoop(parsed, fileLog, { fileLog, status, startOpencodeServer, runner });

      result = { startCalls, stopCalls, requests: stub.requests };
    } finally {
      stub.close();
    }
  });
  return result;
}

test("managed opencode: starts the child once and every phase shares that OpencodeService instance", async () => {
  const { startCalls, stopCalls, requests } = await runOpencodeLoop(false);

  expect(startCalls).toBe(1);
  expect(stopCalls).toBe(1);
  // The repair phase's ledger.startPass calls agents.listSessions() every
  // tick unconditionally — seeing it land on the one fake server proves
  // every phase shares the single OpencodeService this loop constructed.
  expect(requests.some((r) => r.method === "GET" && r.path === "/api/session")).toBe(true);
});

test("managed opencode --dry-run: the child still starts and stops, with zero mutating requests", async () => {
  const { startCalls, stopCalls, requests } = await runOpencodeLoop(true);

  expect(startCalls).toBe(1);
  expect(stopCalls).toBe(1);
  expect(requests.some((r) => r.method === "POST" || r.method === "DELETE")).toBe(false);
});

test("unmanaged bootstrap keeps discovery and env-first tuning", async () => {
  await withEnv(
    {
      GH_REPO: "owner/score",
      TICK_INTERVAL_MS: "5000",
      MAX_PARALLEL: "3",
      WORKTREE_ROOT: "/tmp/wtroot",
      AGENT_CMD: "",
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
      // Unmanaged mode stays bare: no namespace, no prompt dir, default agent.
      expect(boot.namespace).toBeUndefined();
      expect(boot.promptsDir).toBeUndefined();
      expect(boot.agent).toEqual({ harness: "claude" });
    },
  );
});

/** Real subprocess runner for the self-heal fixture-repo tests. */
class ExecRunner implements CommandRunner {
  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    try {
      const stdout = execFileSync(command[0] as string, command.slice(1), {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        command,
        cwd: options.cwd,
        exitCode: 0,
        stdout,
        stderr: "",
        timedOut: false,
        dryRun: false,
      };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return {
        command,
        cwd: options.cwd,
        exitCode: failure.status ?? 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        timedOut: false,
        dryRun: false,
      };
    }
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

/** git repo with one commit; when staged, a synthetic MERGE_HEAD points at HEAD. */
async function fixtureRepo(stagedMerge: boolean): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "score-selfheal-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "score@test.invalid");
  git("config", "user.name", "score");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  if (stagedMerge)
    await writeFile(join(repo, ".git", "MERGE_HEAD"), `${git("rev-parse", "HEAD")}\n`);
  return repo;
}

test("self-heal aborts a staged merge left in the checkout and logs one recovery line", async () => {
  const repo = await fixtureRepo(true);
  const git = new GitService(new ExecRunner(), {
    repositoryPath: repo,
    workspaceRoot: join(repo, "wt"),
  });
  const log = new CaptureLogger();

  await selfHealStagedMerge(git, log, false, "main");

  expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  expect(log.logged).toEqual([
    { level: "warn", text: "recovered staged merge left by a previous run" },
  ]);
});

test("self-heal is silent when no merge is in progress", async () => {
  const repo = await fixtureRepo(false);
  const git = new GitService(new ExecRunner(), {
    repositoryPath: repo,
    workspaceRoot: join(repo, "wt"),
  });
  const log = new CaptureLogger();

  await selfHealStagedMerge(git, log, false, "main");

  expect(log.logged).toEqual([]);
});

test("self-heal fails closed when the abort leaves MERGE_HEAD behind", async () => {
  const stuck = {
    mergeInProgress: async () => true,
    abortMerge: async () => {},
    observePrimaryCheckout: async () => ({ branch: "main", status: "" }),
  };
  await expect(selfHealStagedMerge(stuck, new CaptureLogger(), false, "main")).rejects.toThrow(
    /failed to abort the staged merge/,
  );
});

test("self-heal under dry-run only announces the abort it would run", async () => {
  let aborted = false;
  const git = {
    mergeInProgress: async () => true,
    abortMerge: async () => {
      aborted = true;
    },
    observePrimaryCheckout: async () => ({ branch: "main", status: "" }),
  };
  const log = new CaptureLogger();

  await selfHealStagedMerge(git, log, true, "main");

  expect(aborted).toBe(false);
  expect(log.logged).toEqual([
    {
      level: "warn",
      text: "staged merge left by a previous run (MERGE_HEAD present); would abort",
    },
  ]);
});

test("self-heal never aborts a merge in progress on a non-default branch", async () => {
  const repo = await fixtureRepo(false);
  const gitCli = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  gitCli("checkout", "-b", "operator-work");
  await writeFile(join(repo, ".git", "MERGE_HEAD"), `${gitCli("rev-parse", "HEAD")}\n`);
  const git = new GitService(new ExecRunner(), {
    repositoryPath: repo,
    workspaceRoot: join(repo, "wt"),
  });
  const log = new CaptureLogger();

  await selfHealStagedMerge(git, log, false, "main");

  // The operator's in-progress merge survives the daemon start.
  expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  expect(log.logged).toEqual([
    {
      level: "warn",
      text: "MERGE_HEAD present on operator-work, not main; not landing's merge, leaving it untouched",
    },
  ]);
});
