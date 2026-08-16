import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchdSupervisor } from "@score/core/supervisor/launchd.service";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import { beforeEach, expect, test } from "vitest";

class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly cwds: string[] = [];
  listOutput = "";
  exitCodeFor: (command: readonly string[]) => number = () => 0;

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([...command]);
    this.cwds.push(options.cwd);
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
    // Listed with no plist: booted out but still draining (#93).
    { key: "alpha", loaded: true, pid: 123, stopping: true },
    { key: "beta", loaded: true },
    { key: "stale", loaded: false },
  ]);
  expect(runner.calls).toEqual([["launchctl", "list"]]);
});

test("status propagates a LaunchAgents read failure that is not missing-directory", async () => {
  // A transient I/O or permission failure must not be read as "nothing
  // installed": that would report every listed job as stopping (#93).
  const broken = new LaunchdSupervisor(runner, {
    uid: 501,
    // A file where the directory should be: readdir fails with ENOTDIR.
    launchAgentsDir: join(agentsDir, "not-a-dir"),
  });
  await writeFile(join(agentsDir, "not-a-dir"), "");
  runner.listOutput = "123\t0\tdev.score.alpha";
  await expect(broken.status()).rejects.toThrow();
});

test("launchctl never runs from the agents dir — it may not exist before install", async () => {
  const missing = new LaunchdSupervisor(runner, {
    uid: 501,
    launchAgentsDir: join(agentsDir, "does-not-exist"),
  });
  expect(await missing.status()).toEqual([]);
  await missing.stop("demo");
  await missing.uninstall("demo");
  expect(runner.cwds.every((cwd) => cwd === "/")).toBe(true);
});
