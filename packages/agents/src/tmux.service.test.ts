import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeTmuxShellCommand, TmuxService } from "@score/agents/tmux.service";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import { afterEach, expect, test } from "vitest";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class RecordingRunner implements CommandRunner {
  readonly commands: string[][] = [];
  responses: Array<
    number | { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean }
  > = [];

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.commands.push([...command]);
    const response = this.responses.shift() ?? 0;
    const {
      exitCode = 0,
      stdout = "",
      stderr = "",
      timedOut = false,
    } = typeof response === "number" ? { exitCode: response } : response;
    return {
      command,
      cwd: options.cwd,
      exitCode,
      stdout,
      stderr,
      timedOut,
      dryRun: false,
    };
  }
}

/** The trailing tmux command-sequence args pinning remain-on-exit at spawn. */
const REMAIN_ON_EXIT = (session: string) => [
  ";",
  "set-option",
  "-t",
  session,
  "remain-on-exit",
  "on",
];
/** list-panes says alive; capture-pane empty; set-option off succeeds; recheck alive. */
const ALIVE_BIRTH = [{ stdout: "0\n" }, { stdout: "" }, 0, { stdout: "0\n" }];

async function workIdentity(createDirectory: boolean): Promise<WorkIdentity> {
  const root = await mkdtemp(join(tmpdir(), "score-tmux-test-"));
  sandboxes.push(root);
  const worktreePath = join(root, "issue-7-port-scripts");
  if (createDirectory) await mkdir(worktreePath);
  return {
    issueNumber: 7,
    branch: "issue-7-port-scripts",
    worktreePath,
    sessionName: "issue-7",
  };
}

test("tmux shell boundary preserves spaces and embedded quotes", () => {
  expect(encodeTmuxShellCommand(["codex", "exec", "don't merge; report $URL"])).toBe(
    `'codex' 'exec' 'don'"'"'t merge; report $URL'`,
  );
});

test("implementation launch rejects a missing worktree before calling tmux", async () => {
  const runner = new RecordingRunner();
  const service = new TmuxService(runner, { repositoryPath: "/repo" });

  await expect(
    service.startImplementation(await workIdentity(false), "do the task", { harness: "claude" }),
  ).rejects.toThrow("worktree not found");
  expect(runner.commands).toEqual([]);
});

test("implementation launch refuses to clobber an existing issue session", async () => {
  const runner = new RecordingRunner();
  runner.responses = [0];
  const service = new TmuxService(runner, { repositoryPath: "/repo" });

  await expect(
    service.startImplementation(await workIdentity(true), "do the task", { harness: "claude" }),
  ).rejects.toThrow("tmux session 'issue-7' already exists");
  expect(runner.commands).toEqual([["tmux", "has-session", "-t", "issue-7"]]);
});

test("implementation launch starts the restored interactive Claude command", async () => {
  const runner = new RecordingRunner();
  runner.responses = [1, 0, ...ALIVE_BIRTH];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await service.startImplementation(work, "Read TASK.md and don't merge.", { harness: "claude" });

  // The trust dialog would stall a detached session, so launch pre-seeds it.
  const trust = JSON.parse(await readFile(trustConfigPath, "utf8"));
  expect(trust.projects[work.worktreePath]).toEqual({ hasTrustDialogAccepted: true });

  expect(runner.commands).toEqual([
    ["tmux", "has-session", "-t", "issue-7"],
    [
      "tmux",
      "new-session",
      "-d",
      "-s",
      "issue-7",
      "-c",
      work.worktreePath,
      `'claude' 'Read TASK.md and don'"'"'t merge.'`,
      ...REMAIN_ON_EXIT("issue-7"),
    ],
    ["tmux", "list-panes", "-t", "issue-7", "-F", "#{pane_dead}"],
    ["tmux", "capture-pane", "-p", "-t", "issue-7"],
    ["tmux", "set-option", "-t", "issue-7", "remain-on-exit", "off"],
    ["tmux", "list-panes", "-t", "issue-7", "-F", "#{pane_dead}"],
  ]);
  const launch = runner.commands[1]?.join(" ") ?? "";
  expect(launch).not.toContain(" -p ");
  expect(launch).not.toContain("--permission-mode");
  expect(launch).not.toContain("--model");
});

test("an agent that dies at birth fails the launch with its dying output", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { stdout: "1\n" }, // list-panes: pane dead
    { stdout: "claude: There's an issue with the selected model (fable-5)\n\n" },
    0, // kill-session
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow(
    "agent died at birth in tmux session 'issue-7': claude: There's an issue with the selected model (fable-5)",
  );
  // The dead session is reclaimed so nothing blocks the issue's retry.
  expect(runner.commands.at(-1)).toEqual(["tmux", "kill-session", "-t", "issue-7"]);
});

test("a dead session that survives the kill is named in the error, not silently ignored", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { stdout: "1\n" }, // list-panes: pane dead
    { stdout: "crashed\n" },
    { exitCode: 1 }, // kill-session fails
    0, // has-session: the remain-on-exit session lingers
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow(
    "agent died at birth in tmux session 'issue-7' (dead session could not be killed and will block retries — run: tmux kill-session -t issue-7): crashed",
  );
});

test("a session that vanished entirely at birth still fails the launch", async () => {
  const runner = new RecordingRunner();
  runner.responses = [1, 0, { exitCode: 1 }, { exitCode: 1 }, 0];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow("agent died at birth in tmux session 'issue-7' (no output captured)");
});

test("an EXIT-looking line in a live implementation pane is not a death signal", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { stdout: "0\n" }, // list-panes: pane alive
    { stdout: "EXIT:1\nsome TUI content\n" }, // coincidental pane content
    0, // set-option off
    { stdout: "0\n" }, // recheck: still alive
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  // The EXIT marker belongs to the repair wrapper only; a live implementation
  // pane containing such a line must not be killed.
  await service.startImplementation(work, "do the task", { harness: "claude" });
  expect(runner.commands.some((command) => command[1] === "kill-session")).toBe(false);
});

test("a death between the liveness sample and the option restore is still caught", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { stdout: "0\n" }, // list-panes: alive at sample time
    { stdout: "" }, // capture-pane
    0, // set-option off succeeds
    { stdout: "1\n" }, // recheck: died in the gap, held by remain-on-exit
    0, // kill-session
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow("agent died at birth in tmux session 'issue-7'");
  expect(runner.commands.at(-1)).toEqual(["tmux", "kill-session", "-t", "issue-7"]);
});

test("a spawn whose chained remain-on-exit set fails reclaims any created session", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    { exitCode: 1 }, // new-session ; set-option — aggregate failure
    0, // kill-session
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  // The session may exist with a live agent even though the aggregate command
  // failed; the launch error must not strand it.
  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow("exited 1");
  expect(runner.commands.at(-1)).toEqual(["tmux", "kill-session", "-t", "issue-7"]);
});

test("a timed-out liveness probe fails open instead of killing a possibly-live agent", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { exitCode: -1, timedOut: true }, // list-panes: server unresponsive
    { stdout: "" },
    0, // best-effort set-option off
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await service.startImplementation(work, "do the task", { harness: "claude" });
  expect(runner.commands.some((command) => command[1] === "kill-session")).toBe(false);
  expect(runner.commands.at(-1)).toEqual([
    "tmux",
    "set-option",
    "-t",
    "issue-7",
    "remain-on-exit",
    "off",
  ]);
});

test("a capture timeout cannot overturn a confirmed death", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { stdout: "1\n" }, // list-panes: confirmed dead
    { exitCode: -1, timedOut: true }, // capture-pane times out independently
    0, // kill-session
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  // The fail-open path exists for an unknown liveness verdict, not a missing
  // output capture — a confirmed-dead pane must still fail the launch.
  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow("agent died at birth in tmux session 'issue-7' (no output captured)");
  expect(runner.commands.at(-1)).toEqual(["tmux", "kill-session", "-t", "issue-7"]);
});

test("a live agent whose option restore fails is reclaimed before the throw", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { stdout: "0\n" }, // list-panes: pane alive
    { stdout: "" },
    { exitCode: 1 }, // set-option off fails
    0, // kill-session
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  // The rollback the throw triggers deletes the worktree; a live agent must
  // not survive inside it, nor block the retry as ALREADY_IN_FLIGHT.
  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow("exited 1");
  expect(runner.commands.at(-1)).toEqual(["tmux", "kill-session", "-t", "issue-7"]);
});

test("a restore failure whose reclaim also fails names the surviving session", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    0, // new-session
    { stdout: "0\n" }, // list-panes: pane alive
    { stdout: "" }, // capture-pane
    { exitCode: 1 }, // set-option off fails
    { exitCode: 1 }, // kill-session fails too
    0, // has-session: the session survives
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  // A blocked retry must be named in the error, not hidden behind the plain
  // set-option failure the double fault started with.
  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow(
    "could not restore exit behavior for tmux session 'issue-7' (set-option exited 1), and the session could not be killed and will block retries — run: tmux kill-session -t issue-7",
  );
});

test("a partial spawn failure whose reclaim also fails names the surviving session", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none
    { exitCode: 1, stderr: "set-option failed" }, // new-session ok, chained set-option fails
    { exitCode: 1 }, // kill-session fails too
    0, // has-session: the partially-created session survives
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow(
    "spawning tmux session 'issue-7' failed (exit 1), and the partially-created session could not be killed and will block retries — run: tmux kill-session -t issue-7",
  );
});

test("a spawn losing a name race does not kill the session it collided with", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    1, // has-session: none at check time
    // Another actor claimed the name between the check and new-session:
    // nothing was created, so there is nothing of ours to reclaim.
    { exitCode: 1, stderr: "duplicate session: issue-7" },
  ];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await expect(
    service.startImplementation(work, "do the task", { harness: "claude" }),
  ).rejects.toThrow("duplicate session");
  expect(runner.commands.some((command) => command[1] === "kill-session")).toBe(false);
});

test("dry-run spawns no session and runs no birth check", async () => {
  const runner = new RecordingRunner();
  runner.responses = [1];
  const work = await workIdentity(true);
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    dryRun: true,
    birthGraceMs: 0,
  });

  await service.startImplementation(work, "do the task", { harness: "claude" });

  // has-session then the (runner-gated) new-session — no liveness probes after.
  expect(runner.commands).toHaveLength(2);
  expect(runner.commands[1]?.[1]).toBe("new-session");
});

test("implementation launch pins the configured model through agentArgv", async () => {
  const runner = new RecordingRunner();
  runner.responses = [1, 0, ...ALIVE_BIRTH];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await service.startImplementation(work, "do the task", {
    harness: "claude",
    model: "opus-4.6",
  });

  expect(runner.commands[1]?.[7]).toBe(`'claude' '--model' 'opus-4.6' 'do the task'`);
});

test("repair spawn writes the prompt under promptsDir and namespaces the session", async () => {
  const runner = new RecordingRunner();
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const promptsDir = join(work.worktreePath, "..", "prompts");
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    namespace: "demo",
    promptsDir,
    birthGraceMs: 0,
  });

  await service.startRepair(12, work.worktreePath, "fix PR #12", {
    harness: "claude",
    model: "opus-4.6",
  });

  const promptPath = join(promptsDir, "shepherd-pr-12.prompt");
  expect(await readFile(promptPath, "utf8")).toBe("fix PR #12\n");
  expect(runner.commands[0]).toEqual(["tmux", "kill-session", "-t", "score-demo-shepherd-pr-12"]);
  expect(runner.commands[1]?.slice(0, 7)).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "score-demo-shepherd-pr-12",
    "-c",
    work.worktreePath,
  ]);
  expect(runner.commands[1]?.slice(10)).toEqual(REMAIN_ON_EXIT("score-demo-shepherd-pr-12"));
  const shell = runner.commands[1]?.[9] ?? "";
  // The legacy wrapper is preserved; only the agent command inside it changed.
  expect(shell).toContain("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN");
  expect(shell).toContain(`export GITHUB_TOKEN="$(gh auth token)"`);
  expect(shell).toContain(
    `'claude' '--model' 'opus-4.6' "$(cat '${promptPath}')" --permission-mode bypassPermissions`,
  );
  expect(shell).toContain("echo EXIT:$?");
});

// startRepair boundary audit (#42): kill the writer at each step boundary
// (write prompt → kill-session → new-session) and assert the next pass converges.

test("startRepair: kill-session finds nothing after a death before spawn — tolerated, spawn proceeds (SELF-HEALED)", async () => {
  const runner = new RecordingRunner();
  // kill-session: no such session; new-session ok; then an alive birth check.
  runner.responses = [1, 0, ...ALIVE_BIRTH];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const promptsDir = join(work.worktreePath, "..", "prompts");
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    namespace: "demo",
    promptsDir,
    birthGraceMs: 0,
  });

  await service.startRepair(12, work.worktreePath, "fix PR #12", { harness: "claude" });

  expect(runner.commands.map((command) => command[1])).toEqual([
    "kill-session",
    "new-session",
    "list-panes",
    "capture-pane",
    "set-option",
    "list-panes",
  ]);
});

test("startRepair: child dies at new-session — next pass overwrites the prompt and recovers kill-first (RETRIED)", async () => {
  const runner = new RecordingRunner();
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const promptsDir = join(work.worktreePath, "..", "prompts");
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    namespace: "demo",
    promptsDir,
    birthGraceMs: 0,
  });
  const promptPath = join(promptsDir, "shepherd-pr-12.prompt");

  // kill-session ok, new-session dies, best-effort reclaim of the maybe-created session
  runner.responses = [0, 1, 0];
  await expect(
    service.startRepair(12, work.worktreePath, "first brief", { harness: "claude" }),
  ).rejects.toThrow(/exited 1/);
  // Leftover: only the prompt file; no session survived the failed spawn.
  expect(await readFile(promptPath, "utf8")).toBe("first brief\n");
  expect(runner.commands.map((command) => command[1])).toEqual([
    "kill-session",
    "new-session",
    "kill-session",
  ]);

  // nothing to kill (spawn never happened), then spawn ok and an alive birth check
  runner.responses = [1, 0, ...ALIVE_BIRTH];
  await service.startRepair(12, work.worktreePath, "second brief", { harness: "claude" });

  // Overwritten, not duplicated: exactly the new brief, delivered via $(cat).
  expect(await readFile(promptPath, "utf8")).toBe("second brief\n");
  expect(runner.commands.slice(3).map((command) => command[1])).toEqual([
    "kill-session",
    "new-session",
    "list-panes",
    "capture-pane",
    "set-option",
    "list-panes",
  ]);
  const retriedSpawn = runner.commands[4]?.[9] ?? "";
  expect(retriedSpawn).toContain(`"$(cat '${promptPath}')"`);
});

test("unmanaged repair spawn keeps today's /tmp prompt path and bare session name", async () => {
  const runner = new RecordingRunner();
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });

  await service.startRepair(12, work.worktreePath, "fix PR #12", { harness: "claude" });

  expect(runner.commands[0]).toEqual(["tmux", "kill-session", "-t", "shepherd-pr-12"]);
  expect(runner.commands[1]?.slice(3, 5)).toEqual(["-s", "shepherd-pr-12"]);
  const shell = runner.commands[1]?.[9] ?? "";
  expect(shell).toContain(
    `'claude' "$(cat '/tmp/shepherd-pr-12.prompt')" --permission-mode bypassPermissions`,
  );
});

test("a repair agent that exits inside the grace window fails the spawn with its output", async () => {
  const runner = new RecordingRunner();
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, {
    repositoryPath: "/repo",
    trustConfigPath,
    birthGraceMs: 0,
  });
  runner.responses = [
    0, // kill-session (pre-spawn sweep)
    0, // new-session
    // The bash wrapper parks at `read`, so the pane is NOT dead — the EXIT
    // echo inside the grace window is the death signal.
    { stdout: "0\n" },
    { stdout: "bash: claude: command not found\nEXIT:127\n--- done; press enter to close ---\n" },
    0, // kill-session (reclaim)
  ];

  await expect(
    service.startRepair(12, work.worktreePath, "fix PR #12", { harness: "claude" }),
  ).rejects.toThrow("agent died at birth in tmux session 'shepherd-pr-12'");
  expect(runner.commands.at(-1)).toEqual(["tmux", "kill-session", "-t", "shepherd-pr-12"]);
});
