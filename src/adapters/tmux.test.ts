import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    service.startImplementation(await workIdentity(false), "do the task"),
  ).rejects.toThrow("worktree not found");
  expect(runner.commands).toEqual([]);
});

test("implementation launch refuses to clobber an existing issue session", async () => {
  const runner = new RecordingRunner();
  runner.responses = [0];
  const service = new TmuxService(runner, { repositoryPath: "/repo" });

  await expect(
    service.startImplementation(await workIdentity(true), "do the task"),
  ).rejects.toThrow("tmux session 'issue-7' already exists");
  expect(runner.commands).toEqual([["tmux", "has-session", "-t", "issue-7"]]);
});

test("implementation launch starts the restored interactive Claude command", async () => {
  const runner = new RecordingRunner();
  runner.responses = [1, 0];
  const service = new TmuxService(runner, { repositoryPath: "/repo" });
  const work = await workIdentity(true);

  await service.startImplementation(work, "Read TASK.md and don't merge.");

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
