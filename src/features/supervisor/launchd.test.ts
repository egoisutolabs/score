import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { LaunchdSupervisor } from "@/features/supervisor/launchd";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];
  listOutput = "";
  exitCodeFor: (command: readonly string[]) => number = () => 0;

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([...command]);
    return {
      command: [...command],
      cwd: options.cwd,
      exitCode: this.exitCodeFor(command),
      stdout: command[1] === "list" ? this.listOutput : "",
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  }
}

let runner: RecordingRunner;
let agentsDir: string;
let adapter: LaunchdSupervisor;

beforeEach(async () => {
  runner = new RecordingRunner();
  agentsDir = await mkdtemp(join(tmpdir(), "score-launchd-"));
  adapter = new LaunchdSupervisor(runner, { uid: 501, launchAgentsDir: agentsDir });
});

test("install writes the plist and bootstraps it", async () => {
  await adapter.install("demo", "<plist/>");
  const plistPath = join(agentsDir, "dev.score.demo.plist");
  expect(await readFile(plistPath, "utf8")).toBe("<plist/>");
  expect(runner.calls).toEqual([["launchctl", "bootstrap", "gui/501", plistPath]]);
});

test("start kickstarts the service target", async () => {
  await adapter.start("demo");
  expect(runner.calls).toEqual([["launchctl", "kickstart", "gui/501/dev.score.demo"]]);
});

test("stop boots out and tolerates a job that is not loaded (exit 3)", async () => {
  runner.exitCodeFor = () => 3;
  await adapter.stop("demo");
  expect(runner.calls).toEqual([["launchctl", "bootout", "gui/501/dev.score.demo"]]);
});

test("stop surfaces other launchctl failures", async () => {
  runner.exitCodeFor = () => 5;
  await expect(adapter.stop("demo")).rejects.toThrow("exited 5");
});

test("uninstall boots out and removes the plist, and is idempotent", async () => {
  await writeFile(join(agentsDir, "dev.score.demo.plist"), "<plist/>");
  await adapter.uninstall("demo");
  expect(await readdir(agentsDir)).toEqual([]);
  expect(runner.calls).toEqual([["launchctl", "bootout", "gui/501/dev.score.demo"]]);
  await adapter.uninstall("demo");
});

test("status merges launchctl list with definition-only plists, score namespace only", async () => {
  runner.listOutput = [
    "PID\tStatus\tLabel",
    "123\t0\tdev.score.alpha",
    "-\t0\tdev.score.beta",
    "456\t0\tcom.apple.something",
  ].join("\n");
  await writeFile(join(agentsDir, "dev.score.beta.plist"), "<plist/>");
  await writeFile(join(agentsDir, "dev.score.stale.plist"), "<plist/>");
  await writeFile(join(agentsDir, "com.other.plist"), "<plist/>");
  const status = await adapter.status();
  expect(status).toEqual([
    { key: "alpha", loaded: true, pid: 123 },
    { key: "beta", loaded: true },
    { key: "stale", loaded: false },
  ]);
  expect(runner.calls).toEqual([["launchctl", "list"]]);
});
