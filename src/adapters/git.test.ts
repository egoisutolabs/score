import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { GitService, parseWorktreePorcelain } from "@/adapters/git";
import type { WorkIdentity } from "@/features/dispatch/work";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class ScriptRunner implements CommandRunner {
  readonly commands: string[][] = [];

  constructor(
    private readonly respond: (
      command: readonly string[],
      options: RunCommandOptions,
    ) => Promise<CommandResult> | CommandResult,
  ) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.commands.push([...command]);
    return this.respond(command, options);
  }
}

function result(
  command: readonly string[],
  options: RunCommandOptions,
  exitCode = 0,
  stdout = "",
): CommandResult {
  return {
    command,
    cwd: options.cwd,
    exitCode,
    stdout,
    stderr: "",
    timedOut: false,
    dryRun: false,
  };
}

async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "score-git-test-"));
  sandboxes.push(path);
  return path;
}

function identity(workspaceRoot: string): WorkIdentity {
  return {
    issueNumber: 7,
    branch: "issue-7-port-scripts",
    worktreePath: join(workspaceRoot, "issue-7-port-scripts"),
    sessionName: "issue-7",
  };
}

test("worktree parser retains branch, head, and lock observations", () => {
  const output = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /worktrees/issue-2-port
HEAD def456
branch refs/heads/issue-2-port
locked
`;
  expect(parseWorktreePorcelain(output)).toEqual([
    { path: "/repo", branch: "main", headSha: "abc123", locked: false },
    {
      path: "/worktrees/issue-2-port",
      branch: "issue-2-port",
      headSha: "def456",
      locked: true,
    },
  ]);
});

test("existing worktree directories are reused without touching git or copying files", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  await mkdir(work.worktreePath, { recursive: true });
  const runner = new ScriptRunner((command, options) => result(command, options));

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands).toEqual([]);
});

test("new branches use the local origin-HEAD branch and copy the Claude directory", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  await mkdir(join(repositoryPath, ".claude"), { recursive: true });
  await writeFile(join(repositoryPath, ".claude", "settings.json"), "legacy-settings");
  const runner = new ScriptRunner(async (command, options) => {
    const args = command.slice(1);
    if (args[0] === "symbolic-ref") {
      return result(command, options, 0, "refs/remotes/origin/main\n");
    }
    if (args[0] === "show-ref") return result(command, options, 1);
    if (args[0] === "worktree") await mkdir(work.worktreePath, { recursive: true });
    return result(command, options);
  });

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands.map((command) => command.slice(1))).toEqual([
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    ["show-ref", "--verify", "--quiet", "refs/heads/issue-7-port-scripts"],
    ["worktree", "add", "-b", work.branch, work.worktreePath, "main"],
  ]);
  expect(await readFile(join(work.worktreePath, ".claude", "settings.json"), "utf8")).toBe(
    "legacy-settings",
  );
});

test("existing issue branches are attached without creating a second branch", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  const runner = new ScriptRunner(async (command, options) => {
    const args = command.slice(1);
    if (args[0] === "symbolic-ref") {
      return result(command, options, 0, "refs/remotes/origin/main\n");
    }
    if (args[0] === "worktree") await mkdir(work.worktreePath, { recursive: true });
    return result(command, options);
  });

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands.at(-1)?.slice(1)).toEqual([
    "worktree",
    "add",
    work.worktreePath,
    work.branch,
  ]);
});

test("base resolution falls back from origin HEAD to local main and master", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  const runner = new ScriptRunner(async (command, options) => {
    const ref = command.at(-1);
    if (command[1] === "symbolic-ref") return result(command, options, 1);
    if (ref === "refs/heads/main") return result(command, options, 1);
    if (ref === "refs/heads/master") return result(command, options);
    if (command[1] === "worktree") await mkdir(work.worktreePath, { recursive: true });
    return result(command, options, ref === `refs/heads/${work.branch}` ? 1 : 0);
  });

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands.at(-1)?.slice(1)).toEqual([
    "worktree",
    "add",
    "-b",
    work.branch,
    work.worktreePath,
    "master",
  ]);
});

test("worktree creation fails closed when no legacy base branch can be resolved", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  const runner = new ScriptRunner((command, options) => result(command, options, 1));

  await expect(
    new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work),
  ).rejects.toThrow("no origin/HEAD, no main, no master");
  expect(runner.commands.some((command) => command[1] === "worktree")).toBe(false);
});
