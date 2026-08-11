import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import { discoverLegacyRuntime, runPollingLoop } from "@score/shared/legacy-runtime";
import { expect, test } from "vitest";

class FakeRunner implements CommandRunner {
  readonly calls: { command: readonly string[]; cwd: string }[] = [];

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, cwd: options.cwd });
    const stdout = command[1] === "rev-parse" ? "/repos/score\n" : "";
    return {
      command,
      cwd: options.cwd,
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  }
}

test("repository discovery asks git from this file's directory, not a guessed parent", async () => {
  const runner = new FakeRunner();
  process.env.GH_REPO = "owner/score";

  const runtime = await discoverLegacyRuntime(runner, {
    requireGhAuth: false,
    requireTmux: false,
  });

  // git walks up on its own; a hardcoded "../../.." broke once score became
  // its own repository instead of a subdirectory of the managed one.
  expect(runner.calls[0]?.cwd).toBe(import.meta.dir);
  expect(runtime.repositoryRoot).toBe("/repos/score");
  expect(runtime.repositoryName).toBe("score");
});

test("onReady's requestStop wakes an interruptible idle sleep instead of waiting out the tick", async () => {
  let ticks = 0;
  const startedAt = Date.now();

  await runPollingLoop(
    async () => {
      ticks++;
    },
    false,
    5_000,
    {
      interruptible: true,
      onReady: (requestStop) => {
        setTimeout(() => requestStop(), 10);
      },
    },
  );

  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(ticks).toBe(1);
});

test("requestStop reuses onStopRequested and is idempotent across repeated calls", async () => {
  let stopRequestedCalls = 0;

  await runPollingLoop(async () => {}, false, 5_000, {
    interruptible: true,
    onStopRequested: () => {
      stopRequestedCalls++;
    },
    onReady: (requestStop) => {
      requestStop();
      requestStop();
    },
  });

  expect(stopRequestedCalls).toBe(1);
});

test("onReady is optional; signal-only behavior is unaffected when it is omitted", async () => {
  let ticks = 0;

  await runPollingLoop(
    async () => {
      ticks++;
    },
    true,
    5_000,
  );

  expect(ticks).toBe(1);
});
