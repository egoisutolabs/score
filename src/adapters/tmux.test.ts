import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { encodeTmuxShellCommand, TmuxService } from "@/adapters/tmux";
import type { WorkIdentity } from "@/features/dispatch/work";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class RecordingRunner implements CommandRunner {
  readonly commands: string[][] = [];
  responses: number[] = [];

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.commands.push([...command]);
    return {
      command,
      cwd: options.cwd,
      exitCode: this.responses.shift() ?? 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  }
}

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
  runner.responses = [1, 0];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, { repositoryPath: "/repo", trustConfigPath });

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
    ],
  ]);
  const launch = runner.commands[1]?.join(" ") ?? "";
  expect(launch).not.toContain(" -p ");
  expect(launch).not.toContain("--permission-mode");
  expect(launch).not.toContain("--model");
});

test("implementation launch pins the configured model through agentArgv", async () => {
  const runner = new RecordingRunner();
  runner.responses = [1, 0];
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, { repositoryPath: "/repo", trustConfigPath });

  await service.startImplementation(work, "do the task", {
    harness: "claude",
    model: "opus-4.6",
  });

  expect(runner.commands[1]?.at(-1)).toBe(`'claude' '--model' 'opus-4.6' 'do the task'`);
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
  const shell = runner.commands[1]?.at(-1) ?? "";
  // The legacy wrapper is preserved; only the agent command inside it changed.
  expect(shell).toContain("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN");
  expect(shell).toContain(`export GITHUB_TOKEN="$(gh auth token)"`);
  expect(shell).toContain(
    `'claude' '--model' 'opus-4.6' "$(cat '${promptPath}')" --permission-mode bypassPermissions`,
  );
  expect(shell).toContain("echo EXIT:$?");
});

test("unmanaged repair spawn keeps today's /tmp prompt path and bare session name", async () => {
  const runner = new RecordingRunner();
  const work = await workIdentity(true);
  const trustConfigPath = join(work.worktreePath, "..", "claude.json");
  await writeFile(trustConfigPath, JSON.stringify({ projects: {} }));
  const service = new TmuxService(runner, { repositoryPath: "/repo", trustConfigPath });

  await service.startRepair(12, work.worktreePath, "fix PR #12", { harness: "claude" });

  expect(runner.commands[0]).toEqual(["tmux", "kill-session", "-t", "shepherd-pr-12"]);
  expect(runner.commands[1]?.slice(3, 5)).toEqual(["-s", "shepherd-pr-12"]);
  const shell = runner.commands[1]?.at(-1) ?? "";
  expect(shell).toContain(
    `'claude' "$(cat '/tmp/shepherd-pr-12.prompt')" --permission-mode bypassPermissions`,
  );
});
