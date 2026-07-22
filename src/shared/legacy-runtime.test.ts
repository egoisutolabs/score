import { expect, test } from "vitest";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";
import { discoverLegacyRuntime } from "@/shared/legacy-runtime";

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
