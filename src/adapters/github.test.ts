import { expect, test } from "vitest";

import { GitHubService } from "@/adapters/github";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";

class RecordingRunner implements CommandRunner {
  readonly commands: string[][] = [];
  responses: string[] = [];

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.commands.push([...command]);
    return {
      command,
      cwd: options.cwd,
      exitCode: 0,
      stdout: this.responses.shift() ?? "[]",
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  }
}

test("dispatch and cleanup use narrow legacy GitHub observations", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify({ number: 2, state: "CLOSED", stateReason: "COMPLETED" }),
    JSON.stringify([{ number: 5, headRefName: "issue-2-old-slug" }]),
    JSON.stringify([{ number: 5, headRefName: "issue-2-old-slug", mergedAt: "now" }]),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  await github.observeDependency(2);
  await github.observeOpenChangeHeads();
  await github.observeMergedOwnedChanges();

  expect(runner.commands.map((command) => command.at(-1))).toEqual([
    "number,state,stateReason",
    "number,headRefName",
    "number,headRefName,mergedAt",
  ]);
});

test("repair observation does not request landing-only fields", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify([
      {
        number: 5,
        headRefName: "issue-2-old-slug",
        headRefOid: "cafe1234",
        mergeable: "A_FUTURE_VALUE",
        statusCheckRollup: [],
      },
    ]),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  const observed = (await github.observeRepairChanges())[0];
  expect(observed?.mergeable).toBe("A_FUTURE_VALUE");
  expect(observed?.headSha).toBe("cafe1234");
  expect(runner.commands[0]?.at(-1)).toBe(
    "number,headRefName,headRefOid,mergeable,statusCheckRollup",
  );
});

test("a repair observation without headRefOid stays undefined instead of throwing", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify([{ number: 5, headRefName: "issue-2-x", mergeable: "MERGEABLE" }]),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  expect((await github.observeRepairChanges())[0]?.headSha).toBeUndefined();
});
