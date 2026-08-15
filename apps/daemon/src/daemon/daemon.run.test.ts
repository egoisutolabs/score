import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeServerHandle } from "@score/agents/opencode-server.service";
import { GitService, LANDING_COMMITTER } from "@score/core/adapters/git.service";
import { StatusWriter } from "@score/core/daemon/status.service";
import { createFileLogger } from "@score/shared/file-log";
import { expect, test, vi } from "vitest";
import {
  bootstrapDaemon,
  parseDaemonArguments,
  reconcileUnpushedLandingMerge,
  runDaemon,
  runDaemonLoop,
  selfHealStagedMerge,
} from "./daemon.run";
import type { WedgeFixture } from "./fixtures";
import {
  CaptureLogger,
  commitWedge,
  ExecRunner,
  FakeRunner,
  managedFixture,
  managedResponses,
  managedResponsesSeeded,
  PROVEN_STRAY,
  RECONCILE_OPTIONS,
  SEEDED_ISSUE_BRANCH,
  WEDGE_MESSAGE,
  WEDGE_PR_NUMBER,
  wedgeFixture,
} from "./fixtures";
import { proveLandingAuthorship } from "./recovery.policy";

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
      // dry-run mutation gate BunCommandRunner short-circuits on. The model
      // probe spends quota, which is no preview either — same gate.
      const scrub = runner.calls.find((call) => call.command[1] === "set-environment");
      expect(scrub).toMatchObject({ mutates: true, dryRun: true });
      expect(runner.calls.at(-1)).toMatchObject({ mutates: true, dryRun: true });
      // Read-only preflights must NOT be gated, or dry-run could not verify.
      for (const call of runner.calls.filter(
        (c) => c.command[1] !== "set-environment" && c.command[0] !== "claude",
      )) {
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
        "claude",
      ]);
      // The configured model is proven with the CLI's own print mode (#45):
      // an invalid model zombifies interactive sessions instead of dying, so
      // only a real model call can catch it before dispatch. Billable, so it
      // must come LAST — after every free local check.
      const probe = runner.calls.at(-1);
      expect(probe?.command.slice(0, 3)).toEqual(["claude", "--model", "claude-sonnet-5"]);
      expect(probe?.command).toContain("-p");
    },
  );
});

test("managed bootstrap fails when the configured model flunks the claude probe", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const runner = new FakeRunner((command) => {
      if (command[0] === "claude") return { exitCode: 1 };
      return managedResponses(repo)(command);
    });
    const parsed = parseDaemonArguments(["--project", "demo"]);
    await expect(bootstrapDaemon(parsed, runner)).rejects.toThrow(/claude --model claude-sonnet-5/);
  });
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
    const method = request.method ?? "GET";
    requests.push({ method, path: url.pathname });
    const json = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (method === "GET" && url.pathname === "/api/session") {
      json({ data: [], cursor: {} });
      return;
    }
    // POST /session creates one; every session-scoped mutation below (prompt,
    // abort, delete) just needs to succeed — nothing reads its body.
    if (method === "POST" && url.pathname === "/session") {
      json({ id: "ses_test", title: "fake", location: { directory: "/fake" } });
      return;
    }
    if (
      (method === "POST" && /^\/session\/[^/]+\/(prompt_async|abort)$/.test(url.pathname)) ||
      (method === "DELETE" && /^\/session\/[^/]+$/.test(url.pathname))
    ) {
      response.writeHead(200);
      response.end();
      return;
    }
    if (method === "GET" && /^\/session\/[^/]+$/.test(url.pathname)) {
      json({ id: "ses_test", title: "fake", location: { directory: "/fake" } });
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
  const { home, worktree } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  // Pre-existing worktree dir: createWorktree() short-circuits on it (real
  // git plumbing is out of scope for a FakeRunner), so the briefing write
  // that follows has somewhere real to land TASK.md.
  await mkdir(join(worktree, SEEDED_ISSUE_BRANCH), { recursive: true });
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
      const createOpencodeServer = () => ({
        start: async () => {
          startCalls++;
          return handle;
        },
        stop: () => handle.stop(),
      });

      const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
      const fileLog = createFileLogger(join(runsDir, "logs"), false);
      const status = new StatusWriter(join(runsDir, "status.json"));
      const runner = new FakeRunner(managedResponsesSeeded(repo));
      const args = dryRun
        ? ["--project", "demo", "--once", "--dry-run"]
        : ["--project", "demo", "--once"];
      const parsed = parseDaemonArguments(args);

      await runDaemonLoop(parsed, fileLog, { fileLog, status }, { createOpencodeServer, runner });

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
  // Repair's ledger.startPass calls agents.listSessions() every tick
  // unconditionally (a GET); dispatch only calls startImplementation (a
  // POST) because a real candidate was seeded. Both landing on the one fake
  // server proves cleanup+dispatch and repair share the same instance.
  expect(requests.some((r) => r.method === "GET" && r.path === "/api/session")).toBe(true);
  expect(requests.some((r) => r.method === "POST" && r.path === "/session")).toBe(true);
  expect(
    requests.some((r) => r.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(r.path)),
  ).toBe(true);
});

test("managed opencode --dry-run: the child still starts and stops, with zero mutating requests", async () => {
  const { startCalls, stopCalls, requests } = await runOpencodeLoop(true);

  expect(startCalls).toBe(1);
  expect(stopCalls).toBe(1);
  // Same seeded candidate as the non-dry-run test above — proven there to
  // produce a POST — makes zero mutations here a real assertion, not a
  // vacuous one from an empty backlog.
  expect(requests.some((r) => r.method === "POST" || r.method === "DELETE")).toBe(false);
});

test("managed opencode: an unexpected child exit rejects runDaemonLoop with the child error and stops the child exactly once", async () => {
  // Exercises the onReady/childError wiring inside runDaemonLoop itself —
  // not the standalone reimplementation in managed-loop.fixture.ts — so a
  // regression that drops the throw or breaks the requestStop wiring here
  // fails a test that actually calls the production entry point.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  await withEnv({ SCORE_HOME: home }, async () => {
    const stub = await startFakeOpencodeServer();
    try {
      let stopCalls = 0;
      const handle: OpencodeServerHandle = {
        baseUrl: stub.baseUrl,
        // Already resolved: the child "exited" before the loop even starts,
        // so the very first tick's shouldStop() check settles the race
        // deterministically instead of depending on real time passing.
        unexpectedExit: Promise.resolve(),
        stop: async () => {
          stopCalls++;
        },
      };
      const createOpencodeServer = () => ({ start: async () => handle, stop: () => handle.stop() });

      const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
      const fileLog = createFileLogger(join(runsDir, "logs"), false);
      const status = new StatusWriter(join(runsDir, "status.json"));
      const runner = new FakeRunner(managedResponsesSeeded(repo));
      // once:false — a fatal exit must interrupt the long-running loop, not
      // just be reachable when the loop was already going to stop anyway.
      const parsed = parseDaemonArguments(["--project", "demo"]);

      await expect(
        runDaemonLoop(parsed, fileLog, { fileLog, status }, { createOpencodeServer, runner }),
      ).rejects.toThrow("opencode child exited unexpectedly");

      expect(stopCalls).toBe(1);
    } finally {
      stub.close();
    }
  });
}, 20_000);

test("opencode without --managed: an unexpected child exit wakes an idle sleep immediately, not just under managedRuntime", async () => {
  // Mirrors runDaemon's own unmanaged call site (daemon.run.ts:371):
  // runDaemonLoop(parsed, log) with NO third argument. `reactive` falls
  // back to `opencodeHandle !== undefined` specifically for this shape —
  // a bare `--project X` run without `--managed` still owns the opencode
  // child it spawned and must wake its idle sleep the same way a managed
  // run does, not wait out the full (5s, per managedFixture) tick.
  //
  // A plain "it eventually rejects" assertion would NOT catch a dropped
  // `|| opencodeHandle !== undefined` fallback: onReady's childError/reject
  // wiring is unconditional on opencodeHandle alone, so the loop still
  // rejects eventually either way — only the non-interruptible sleep
  // actually waiting out the full tick before noticing exposes the
  // regression, hence asserting elapsed time here.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  await withEnv({ SCORE_HOME: home }, async () => {
    const stub = await startFakeOpencodeServer();
    try {
      let stopCalls = 0;
      let resolveExit!: () => void;
      const unexpectedExit = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const handle: OpencodeServerHandle = {
        baseUrl: stub.baseUrl,
        unexpectedExit,
        stop: async () => {
          stopCalls++;
        },
      };
      const createOpencodeServer = () => ({ start: async () => handle, stop: () => handle.stop() });
      const runner = new FakeRunner(managedResponses(repo));
      const parsed = parseDaemonArguments(["--project", "demo"]);

      const startedAt = Date.now();
      const loopPromise = runDaemonLoop(parsed, new CaptureLogger(), undefined, {
        createOpencodeServer,
        runner,
      });
      // Comfortably after the first (near-instant, FakeRunner-backed) pass
      // has entered the idle sleep, comfortably before the fixture's 5s tick.
      setTimeout(resolveExit, 300);

      await expect(loopPromise).rejects.toThrow("opencode child exited unexpectedly");

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(stopCalls).toBe(1);
    } finally {
      stub.close();
    }
  });
}, 20_000);

test("SIGINT during opencode startup stops the not-yet-ready child, not just an already-ready one", async () => {
  // The child is alive for the entire spawn-to-ready window (up to
  // startupDeadlineMs) before start() ever resolves. A signal net keyed off
  // the resolved handle would silently no-op for that whole window; this
  // proves stopChild is reachable before start() settles, not just after.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  await withEnv({ SCORE_HOME: home }, async () => {
    let stopCalls = 0;
    // Never resolves on its own — only stop() ever settles it, exactly like
    // the real OpencodeServer.stop() aborting an in-flight start().
    const stuckStart = new Promise<never>(() => {});
    const createOpencodeServer = () => ({
      start: () => stuckStart,
      stop: async () => {
        stopCalls++;
      },
    });

    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new StatusWriter(join(runsDir, "status.json"));
    const runner = new FakeRunner(managedResponses(repo));
    const parsed = parseDaemonArguments(["--project", "demo"]);

    // earlyStop's real effect (process.exit) must not tear down this worker
    // — and must not throw either, or its `.finally(() => process.exit(1))`
    // caller (a fire-and-forget `void` expression) turns that into an
    // unhandled rejection.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    // SIGINT self-removes via process.once() once it fires below, but the
    // paired SIGTERM listener never does — snapshot and diff so cleanup
    // removes only what this test added, not any other listener.
    const priorSigint = process.listeners("SIGINT");
    const priorSigterm = process.listeners("SIGTERM");
    try {
      // Fire-and-forget: runDaemonLoop is permanently suspended awaiting
      // stuckStart, so nothing here ever awaits its return.
      void runDaemonLoop(
        parsed,
        fileLog,
        { fileLog, status },
        { createOpencodeServer, runner },
      ).catch(() => {});
      // Let bootstrap's sequential preflight awaits run their course and
      // land on the earlyStop registration before signaling.
      const deadline = Date.now() + 5_000;
      while (!process.listeners("SIGINT").some((listener) => !priorSigint.includes(listener))) {
        if (Date.now() > deadline) throw new Error("timed out waiting for SIGINT registration");
        await new Promise((resolve) => setImmediate(resolve));
      }

      process.emit("SIGINT");
      await new Promise((resolve) => setImmediate(resolve));

      expect(stopCalls).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      for (const listener of process.listeners("SIGINT")) {
        if (!priorSigint.includes(listener)) process.off("SIGINT", listener as () => void);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!priorSigterm.includes(listener)) process.off("SIGTERM", listener as () => void);
      }
    }
  });
}, 20_000);

test("a second SIGINT during a slow opencode shutdown escalation still reaches earlyStop", async () => {
  // .once() is per event NAME: registering it for SIGINT and SIGTERM both
  // still self-removes independently per name, so two DIFFERENT signals
  // would each fire even with .once(). The real gap is the SAME signal
  // arriving twice — e.g. an operator hitting Ctrl+C again while stop() is
  // still escalating past a SIGTERM-ignoring child toward SIGKILL — which
  // .once() would swallow on the second delivery. earlyStop must stay
  // armed across repeats of the same signal, not just across signal names.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  await withEnv({ SCORE_HOME: home }, async () => {
    let stopCalls = 0;
    const stuckStart = new Promise<never>(() => {});
    // Never resolves — simulates stop() still escalating when the second
    // signal arrives, so a swallowed second signal is observable as
    // stopCalls staying at 1 instead of advancing to 2.
    const createOpencodeServer = () => ({
      start: () => stuckStart,
      stop: async () => {
        stopCalls++;
        await new Promise(() => {});
      },
    });

    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new StatusWriter(join(runsDir, "status.json"));
    const runner = new FakeRunner(managedResponses(repo));
    const parsed = parseDaemonArguments(["--project", "demo"]);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const priorSigint = process.listeners("SIGINT");
    const priorSigterm = process.listeners("SIGTERM");
    try {
      void runDaemonLoop(
        parsed,
        fileLog,
        { fileLog, status },
        { createOpencodeServer, runner },
      ).catch(() => {});
      const deadline = Date.now() + 5_000;
      while (!process.listeners("SIGINT").some((listener) => !priorSigint.includes(listener))) {
        if (Date.now() > deadline) throw new Error("timed out waiting for SIGINT registration");
        await new Promise((resolve) => setImmediate(resolve));
      }

      process.emit("SIGINT");
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopCalls).toBe(1);

      // The escalation is still stuck (stop() never resolves); a second
      // SIGINT — the SAME signal name — must still reach earlyStop. A
      // process.once() listener would have self-removed after the first
      // delivery and silently swallow this one.
      process.emit("SIGINT");
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopCalls).toBe(2);
    } finally {
      exitSpy.mockRestore();
      for (const listener of process.listeners("SIGINT")) {
        if (!priorSigint.includes(listener)) process.off("SIGINT", listener as () => void);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!priorSigterm.includes(listener)) process.off("SIGTERM", listener as () => void);
      }
    }
  });
}, 20_000);

test("a signal during the final child-stop call after the loop exits still reaches earlyStop", async () => {
  // Once runPollingLoop returns (a normal --once pass here), its own
  // graceful SIGINT/SIGTERM handlers have already run their course and
  // removed themselves. Nothing protects the finally block's own
  // `await opencodeHandle?.stop()` unless it's re-armed — and that stop()
  // can itself take seconds to escalate past a SIGTERM-ignoring child.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, {
    harness: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  await withEnv({ SCORE_HOME: home }, async () => {
    const stub = await startFakeOpencodeServer();
    try {
      let stopCalls = 0;
      const handle: OpencodeServerHandle = {
        baseUrl: stub.baseUrl,
        // Never fires — this run settles via --once, not a child exit.
        unexpectedExit: new Promise(() => {}),
        stop: async () => {
          stopCalls++;
          // Never resolves — simulates stop() still escalating (e.g. the
          // SIGKILL grace period) when the signal below arrives.
          await new Promise(() => {});
        },
      };
      const createOpencodeServer = () => ({ start: async () => handle, stop: () => handle.stop() });
      const runner = new FakeRunner(managedResponses(repo));
      const parsed = parseDaemonArguments(["--project", "demo", "--once"]);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const priorSigint = process.listeners("SIGINT");
      const priorSigterm = process.listeners("SIGTERM");
      try {
        void runDaemonLoop(parsed, new CaptureLogger(), undefined, {
          createOpencodeServer,
          runner,
        }).catch(() => {});

        // Wait for the (near-instant, --once) pass to complete and reach
        // the final stop() call, observed via stopCalls incrementing.
        const deadline = Date.now() + 5_000;
        while (stopCalls === 0) {
          if (Date.now() > deadline) throw new Error("timed out waiting for the final stop() call");
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(stopCalls).toBe(1);

        // A signal arriving while that stop() is still escalating must
        // still reach earlyStop, re-armed for exactly this window. stop()
        // never resolves here, so process.exit's .finally() never fires —
        // stopCalls advancing to 2 is what proves earlyStop fired again,
        // instead of the signal hitting the runtime default unprotected.
        process.emit("SIGINT");
        await new Promise((resolve) => setImmediate(resolve));
        expect(stopCalls).toBe(2);
      } finally {
        exitSpy.mockRestore();
        for (const listener of process.listeners("SIGINT")) {
          if (!priorSigint.includes(listener)) process.off("SIGINT", listener as () => void);
        }
        for (const listener of process.listeners("SIGTERM")) {
          if (!priorSigterm.includes(listener)) process.off("SIGTERM", listener as () => void);
        }
      }
    } finally {
      stub.close();
    }
  });
}, 20_000);

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

test("the landing-authorship proof passes all four checks and names the PR to re-land", () => {
  expect(proveLandingAuthorship(PROVEN_STRAY)).toEqual({ proven: true, pullRequestNumber: 12 });
});

test("proof check 1 fails a non-merge commit", () => {
  expect(
    proveLandingAuthorship({
      ...PROVEN_STRAY,
      commit: { ...PROVEN_STRAY.commit, parents: ["originsha"] },
    }),
  ).toEqual({ proven: false, evidence: "not a merge commit (1 parent(s))" });
});

test("proof check 2 fails a first parent outside origin's history", () => {
  expect(
    proveLandingAuthorship({ ...PROVEN_STRAY, firstParentReachableFromOrigin: false }),
  ).toEqual({
    proven: false,
    evidence: "first parent originsha is not an ancestor of origin's head",
  });
});

test("proof check 3 fails messages off landing's template, including a foreign owner", () => {
  expect(
    proveLandingAuthorship({
      ...PROVEN_STRAY,
      commit: { ...PROVEN_STRAY.commit, message: "Merge branch 'issue-12-fix'" },
    }),
  ).toEqual({
    proven: false,
    evidence: `message "Merge branch 'issue-12-fix'" does not match landing's merge template`,
  });
  expect(
    proveLandingAuthorship({
      ...PROVEN_STRAY,
      commit: {
        ...PROVEN_STRAY.commit,
        message: "Merge pull request #12 from someoneelse/issue-12-fix\n\nFix the thing",
      },
    }),
  ).toMatchObject({ proven: false });
});

test("proof check 4 requires landing's full stamp — ambient identity and name-only mismatches fail", () => {
  // Required, not corroborating (D1): checks 1-3 are satisfiable by an
  // operator merge under the same ambient identity, so nothing unstamped
  // may auto-reset — including strays predating the stamp. Both halves of
  // the identity count: a matching email under a foreign name is not proven.
  const foreign = [
    { committerName: "score", committerEmail: "operator@test.invalid" },
    { committerName: "Foreign", committerEmail: "foreign@elsewhere.invalid" },
    { committerName: "Operator", committerEmail: LANDING_COMMITTER.email },
  ];
  for (const identity of foreign) {
    expect(
      proveLandingAuthorship({
        ...PROVEN_STRAY,
        commit: { ...PROVEN_STRAY.commit, ...identity },
      }),
    ).toEqual({
      proven: false,
      evidence: `committer ${identity.committerName} <${identity.committerEmail}> is not landing's stamp ${LANDING_COMMITTER.name} <${LANDING_COMMITTER.email}>`,
    });
  }
});

/** Reconciles, then asserts main did not move and exactly one warning matched. */
async function expectUntouched(fixture: WedgeFixture, evidence: RegExp): Promise<void> {
  const before = fixture.gitCli("rev-parse", "main");
  const log = new CaptureLogger();

  const outcome = await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  // "blocked" is what suppresses landing for the pass — a refused wedge must
  // never let landing stack another merge on top.
  expect(outcome).toBe("blocked");
  expect(fixture.gitCli("rev-parse", "main")).toBe(before);
  expect(log.logged).toEqual([{ level: "warn", text: expect.stringMatching(evidence) }]);
}

test("reconcile is silent and reports clean when local main matches origin", async () => {
  const fixture = await wedgeFixture();
  const log = new CaptureLogger();

  const outcome = await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  expect(outcome).toBe("clean");
  expect(log.logged).toEqual([]);
});

test("reconcile resets a landing-authored unpushed merge and the PR re-stages cleanly", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  // The stamp is metadata-only: author stays the checkout user, committer is landing's.
  expect(fixture.gitCli("log", "-1", "--format=%ae %ce")).toBe(
    `score@test.invalid ${LANDING_COMMITTER.email}`,
  );
  const log = new CaptureLogger();

  const outcome = await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  expect(outcome).toBe("recovered");
  expect(fixture.gitCli("rev-parse", "main")).toBe(fixture.gitCli("rev-parse", "origin/main"));
  expect(log.logged).toEqual([
    {
      level: "warn",
      text: expect.stringContaining(
        `PR #${WEDGE_PR_NUMBER} re-lands through the normal landing tick`,
      ),
    },
  ]);
  // The still-open PR's branch survived and re-stages cleanly on the recovered checkout.
  expect(await fixture.git.stageMerge(fixture.featureSha)).toBe(true);
  await fixture.git.abortMerge();
});

test("reconcile still recovers when origin advanced during the outage", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  // Someone else lands work on origin while the daemon is down.
  const other = join(await mkdtemp(join(tmpdir(), "score-elsewhere-")), "repo");
  execFileSync("git", ["clone", fixture.originPath, other], { stdio: "ignore" });
  const otherCli = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: other,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  otherCli("config", "user.email", "other@test.invalid");
  otherCli("config", "user.name", "other");
  otherCli("config", "commit.gpgsign", "false");
  await writeFile(join(other, "other.txt"), "other\n");
  otherCli("add", "other.txt");
  otherCli("commit", "-m", "someone else's landing");
  otherCli("push", "origin", "main");
  const advancedSha = otherCli("rev-parse", "main");
  const log = new CaptureLogger();

  await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  // Check 2's ancestor form: the wedge's first parent is an ancestor of, not
  // equal to, the advanced origin head — recovery resets to the newer origin.
  expect(fixture.gitCli("rev-parse", "main")).toBe(advancedSha);
  expect(log.logged).toEqual([
    { level: "warn", text: expect.stringContaining(`PR #${WEDGE_PR_NUMBER}`) },
  ]);
});

test("the recovery reset is compare-and-swap: an operator commit after observation aborts it", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  const wedgeSha = fixture.gitCli("rev-parse", "main");
  const originSha = fixture.gitCli("rev-parse", "origin/main");
  // The operator commits between the daemon's observation and its reset —
  // a plain reset --hard would silently discard this commit.
  await writeFile(join(fixture.repo, "operator.txt"), "operator\n");
  fixture.gitCli("add", "operator.txt");
  fixture.gitCli("commit", "-m", "operator work");
  const operatorSha = fixture.gitCli("rev-parse", "main");

  await expect(fixture.git.resetBranchToCommit("main", originSha, wedgeSha)).rejects.toThrow();

  expect(fixture.gitCli("rev-parse", "main")).toBe(operatorSha);
});

test("a mid-window edit aborts the recovery reset before anything moves", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  const wedgeSha = fixture.gitCli("rev-parse", "main");
  const originSha = fixture.gitCli("rev-parse", "origin/main");
  // The operator edits a tracked file the reset would rewrite, after the
  // daemon's checks but before the reset executes. The tree sync runs first
  // and refuses — the ref must not have moved, and the edit must survive.
  await writeFile(join(fixture.repo, "feature.txt"), "operator-edit\n");

  await expect(fixture.git.resetBranchToCommit("main", originSha, wedgeSha)).rejects.toThrow();

  expect(fixture.gitCli("rev-parse", "main")).toBe(wedgeSha);
  expect(await readFile(join(fixture.repo, "feature.txt"), "utf8")).toBe("operator-edit\n");
});

test("a crash between recovery's tree sync and its ref move completes on the next pass", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  const wedgeSha = fixture.gitCli("rev-parse", "main");
  const originSha = fixture.gitCli("rev-parse", "origin/main");
  // The kill window: index/worktree already hold origin's exact tree while
  // the branch still points at the wedge. Reconciliation must recognize this
  // as its own unfinished work — not operator dirt — and finish the job.
  fixture.gitCli("read-tree", "-m", "-u", wedgeSha, originSha);
  const log = new CaptureLogger();

  const outcome = await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  expect(outcome).toBe("recovered");
  expect(fixture.gitCli("rev-parse", "main")).toBe(originSha);
  expect(fixture.gitCli("status", "--porcelain")).toBe("");
});

test("the committer stamp survives inherited GIT_COMMITTER_* overrides", async () => {
  // A daemon started from a shell exporting GIT_COMMITTER_* must still stamp
  // landing's identity, or its own wedge would fail check 4 forever.
  const fixture = await wedgeFixture();
  await withEnv(
    { GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@test.invalid" },
    async () => {
      await commitWedge(fixture);
    },
  );
  expect(fixture.gitCli("log", "-1", "--format=%cn <%ce>")).toBe(
    `${LANDING_COMMITTER.name} <${LANDING_COMMITTER.email}>`,
  );
  const log = new CaptureLogger();

  const outcome = await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  expect(outcome).toBe("recovered");
  expect(fixture.gitCli("rev-parse", "main")).toBe(fixture.gitCli("rev-parse", "origin/main"));
});

test("check 1 fixture: a non-merge stray commit is warned and left untouched", async () => {
  const fixture = await wedgeFixture();
  // Template message and landing's stamp, but a plain commit — check 1 alone fails.
  execFileSync("git", ["commit", "--allow-empty", "-m", WEDGE_MESSAGE], {
    cwd: fixture.repo,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: LANDING_COMMITTER.name,
      GIT_COMMITTER_EMAIL: LANDING_COMMITTER.email,
    },
  });
  await expectUntouched(fixture, /not a merge commit \(1 parent\(s\)\)/);
});

test("check 2 fixture: a merge grown from a commit outside origin is warned and left untouched", async () => {
  const fixture = await wedgeFixture();
  // An operator commit slips under the merge: the merge's first parent is no
  // longer reachable from origin — multi-commit divergence stays untouched.
  await writeFile(join(fixture.repo, "operator.txt"), "operator\n");
  fixture.gitCli("add", "operator.txt");
  fixture.gitCli("commit", "-m", "operator work");
  await commitWedge(fixture);
  await expectUntouched(fixture, /first parent \w+ is not an ancestor of origin's head/);
});

test("check 3 fixture: a merge with a foreign message is warned and left untouched", async () => {
  const fixture = await wedgeFixture();
  expect(await fixture.git.stageMerge(fixture.featureSha)).toBe(true);
  await fixture.git.commitMerge("Merge branch 'fix-the-thing'");
  await expectUntouched(fixture, /does not match landing's merge template/);
});

test("check 4 fixture: a merge from a foreign committer is warned and left untouched", async () => {
  const fixture = await wedgeFixture();
  expect(await fixture.git.stageMerge(fixture.featureSha)).toBe(true);
  execFileSync("git", ["commit", "-m", WEDGE_MESSAGE], {
    cwd: fixture.repo,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: "Foreign",
      GIT_COMMITTER_EMAIL: "foreign@elsewhere.invalid",
    },
  });
  await expectUntouched(
    fixture,
    /committer Foreign <foreign@elsewhere\.invalid> is not landing's stamp/,
  );
});

test("an unstamped merge matching checks 1-3 stays untouched — pre-stamp strays are manual (D1)", async () => {
  const fixture = await wedgeFixture();
  expect(await fixture.git.stageMerge(fixture.featureSha)).toBe(true);
  // What commitMerge wrote before the landing stamp existed: a plain commit,
  // committer = the checkout's ambient identity. An operator merge looks the
  // same, so this must surface as a warning, never auto-reset.
  fixture.gitCli("commit", "-m", WEDGE_MESSAGE);
  await expectUntouched(fixture, /committer score <score@test\.invalid> is not landing's stamp/);
});

test("the scheduler lock file does not count as dirt — recovery still resets over it", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  // Harness-generated churn, not an operator edit; counting it as dirt would
  // wedge recovery forever on a live daemon. The directory is WHOLLY
  // untracked — per-file untracked status must keep the lock visible to the
  // exact-path filter instead of collapsing it into "?? .claude/".
  await mkdir(join(fixture.repo, ".claude"), { recursive: true });
  await writeFile(join(fixture.repo, ".claude", "scheduled_tasks.lock"), "lock\n");
  const log = new CaptureLogger();

  await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  expect(fixture.gitCli("rev-parse", "main")).toBe(fixture.gitCli("rev-parse", "origin/main"));
  expect(log.logged).toEqual([
    { level: "warn", text: expect.stringContaining(`PR #${WEDGE_PR_NUMBER}`) },
  ]);
});

test("a dirty working tree over the wedge refuses recovery loudly and resets nothing", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  await writeFile(join(fixture.repo, "README.md"), "operator edit\n");
  const before = fixture.gitCli("rev-parse", "main");
  const log = new CaptureLogger();

  await reconcileUnpushedLandingMerge(fixture.git, log, RECONCILE_OPTIONS);

  expect(fixture.gitCli("rev-parse", "main")).toBe(before);
  expect(await readFile(join(fixture.repo, "README.md"), "utf8")).toBe("operator edit\n");
  expect(log.logged).toEqual([
    { level: "warn", text: expect.stringMatching(/working tree is dirty; refusing recovery/) },
  ]);
});

test("a file merely containing the lock name is still dirt — only the exact path is blessed", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  // A substring match would bless this operator file and let the reset eat it.
  await mkdir(join(fixture.repo, "docs", ".claude"), { recursive: true });
  await writeFile(join(fixture.repo, "docs", ".claude", "scheduled_tasks.lock"), "operator\n");
  await expectUntouched(fixture, /working tree is dirty; refusing recovery/);
});

test("a wedge with the checkout parked on another branch is warned and left untouched", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  fixture.gitCli("checkout", "-b", "operator-work");
  await expectUntouched(fixture, /checkout is on operator-work; leaving it untouched/);
});

test("dry-run over the wedge reports the would-be reset and mutates nothing", async () => {
  const fixture = await wedgeFixture();
  await commitWedge(fixture);
  const before = fixture.gitCli("rev-parse", "main");
  const log = new CaptureLogger();

  await reconcileUnpushedLandingMerge(fixture.git, log, { ...RECONCILE_OPTIONS, dryRun: true });

  expect(fixture.gitCli("rev-parse", "main")).toBe(before);
  expect(log.logged).toEqual([
    {
      level: "warn",
      text: expect.stringMatching(
        /would reset main to [0-9a-f]{40}.*PR #9 would re-land through the normal landing tick/,
      ),
    },
  ]);
});

test("a push failure inside one pass is reconciled by a later pass of the same daemon — no restart", async () => {
  // The wedge is created BY the loop itself: landing soaks the PR green on
  // tick 0, merges on tick 2, and its push fails (the throw is caught, the
  // daemon lives). The next pass's reconciliation must then reset the wedge
  // — a startup-only recovery would never fire here, which is exactly the
  // regression this test pins.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo, undefined, 25);
  await withEnv({ SCORE_HOME: home }, async () => {
    const prJson = JSON.stringify({
      number: 9,
      title: "Fix the thing",
      headRefName: "fix-the-thing",
      headRefOid: "fff",
      mergeable: "MERGEABLE",
      reviewDecision: null,
    });
    let wedged = false;
    let resetDone = false;
    const base = managedResponses(repo);
    const originCommit = "ooo\n\nboot\nboot@test.invalid\ninitial";
    // What GitService.commitMerge writes: landing's stamp, landing's template.
    const wedgeCommit = `aaa\nooo fff\n${LANDING_COMMITTER.name}\n${LANDING_COMMITTER.email}\nMerge pull request #9 from egoisutolabs/fix-the-thing\n\nFix the thing`;
    const runner = new FakeRunner((command) => {
      if (command[0] === "gh" && command[1] === "pr" && command[2] === "list") {
        // After recovery the PR is left for the next landing cycle; an empty
        // backlog keeps the tail of the test deterministic.
        return { stdout: resetDone ? "[]\n" : `[${prJson}]\n` };
      }
      if (command[0] === "gh" && command[1] === "issue") return { stdout: "[]\n" };
      if (command[0] === "gh" && command[1] === "api") {
        return {
          stdout:
            '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}\n',
        };
      }
      // The merged-tree gate (make verify) is green every tick.
      if (command[0] === "make") return {};
      if (command[0] !== "git") return base(command);
      if (command[1] === "rev-parse" && command.includes("MERGE_HEAD")) return { exitCode: 1 };
      if (
        command[1] === "rev-parse" &&
        command.includes("--abbrev-ref") &&
        command.includes("HEAD")
      ) {
        return { stdout: "develop\n" };
      }
      if (command[1] === "log") {
        const atWedge = wedged && command.at(-1) === "develop";
        return { stdout: `${atWedge ? wedgeCommit : originCommit}\n` };
      }
      // Only the wedge's first parent ooo is an ancestor of origin's head;
      // the wedge head aaa itself is not (so "behind origin" reads false).
      if (command[1] === "merge-base") return { exitCode: command[3] === "aaa" ? 1 : 0 };
      if (command.includes("commit")) {
        wedged = true;
        return {};
      }
      if (command[1] === "push") return { exitCode: 1 };
      if (command[1] === "update-ref") {
        wedged = false;
        resetDone = true;
        return {};
      }
      return base(command);
    });

    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new StatusWriter(join(runsDir, "status.json"));
    const log = new CaptureLogger();
    const resetWarn =
      "reset unpushed landing merge aaa away; PR #9 re-lands through the normal landing tick";
    const priorSigint = process.listeners("SIGINT");
    const priorSigterm = process.listeners("SIGTERM");
    try {
      // No --once: the whole point is a multi-pass life. Stopped via SIGINT
      // (runPollingLoop's own graceful path) once recovery is observed.
      const parsed = parseDaemonArguments(["--project", "demo"]);
      const loopPromise = runDaemonLoop(parsed, log, { fileLog, status }, { runner });
      const deadline = Date.now() + 15_000;
      while (!log.logged.some((line) => line.text === resetWarn) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      process.emit("SIGINT");
      await loopPromise;
    } finally {
      for (const listener of process.listeners("SIGINT")) {
        if (!priorSigint.includes(listener)) process.off("SIGINT", listener as () => void);
      }
      for (const listener of process.listeners("SIGTERM")) {
        if (!priorSigterm.includes(listener)) process.off("SIGTERM", listener as () => void);
      }
    }

    // The wedge was created by landing's own failed push, then healed by a
    // later pass: exactly one commit, one push attempt, one reset — in order.
    const commitIndex = runner.calls.findIndex((call) => call.command.includes("commit"));
    const pushIndex = runner.calls.findIndex((call) => call.command[1] === "push");
    const resetIndex = runner.calls.findIndex((call) => call.command[1] === "update-ref");
    expect(commitIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(commitIndex);
    expect(resetIndex).toBeGreaterThan(pushIndex);
    expect(runner.calls.filter((call) => call.command[1] === "push")).toHaveLength(1);
    expect(runner.calls.filter((call) => call.command[1] === "update-ref")).toEqual([
      {
        // CAS from the observed wedge head to the observed origin SHA —
        // pinned SHAs on both sides, never the movable refs.
        command: [
          "git",
          "update-ref",
          "-m",
          "score: D1 unpushed-merge recovery",
          "refs/heads/develop",
          "ooo",
          "aaa",
        ],
        cwd: repo,
        mutates: true,
        dryRun: false,
      },
    ]);
    // The failed push surfaced as attention, and recovery named the PR.
    expect(log.logged).toContainEqual({
      level: "warn",
      text: "needs attention (push-failed): #9",
    });
    expect(log.logged).toContainEqual({ level: "warn", text: resetWarn });
  });
}, 20_000);

test("a transient reconcile failure warns and the pass continues — only reset verification may crash", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withEnv({ SCORE_HOME: home }, async () => {
    const base = managedResponses(repo);
    const runner = new FakeRunner((command) => {
      if (command[0] === "gh" && (command[1] === "issue" || command[1] === "pr")) {
        return { stdout: "[]\n" };
      }
      if (command[1] === "rev-parse" && command.includes("MERGE_HEAD")) return { exitCode: 1 };
      // The network blip: every fetch fails, including reconciliation's.
      if (command[1] === "fetch") return { exitCode: 1 };
      return base(command);
    });

    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new StatusWriter(join(runsDir, "status.json"));
    const log = new CaptureLogger();
    const parsed = parseDaemonArguments(["--project", "demo", "--once"]);

    // The pass must complete, not reject: reconciliation degrades to a
    // warning like any phase error instead of killing the daemon.
    await runDaemonLoop(parsed, log, { fileLog, status }, { runner });

    expect(log.logged.some((line) => line.text.startsWith("✗ reconciliation failed:"))).toBe(true);
    expect(runner.calls.some((call) => call.command[1] === "update-ref")).toBe(false);
    // An unverified checkout must also suppress landing for the pass — the
    // wedge (if one exists) would otherwise grow a second merge on top.
    expect(log.logged.some((line) => line.text.startsWith("landing suppressed this pass"))).toBe(
      true,
    );
  });
});
