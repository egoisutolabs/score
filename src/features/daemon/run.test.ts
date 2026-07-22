import { expect, test } from "vitest";
import { parseDaemonArguments } from "@/features/daemon/run";

test("daemon flags parse and default to the long-running loop", () => {
  expect(parseDaemonArguments([])).toEqual({
    once: false,
    dryRun: false,
    verbose: false,
    noMerge: false,
  });
  expect(parseDaemonArguments(["--once", "--dry-run"])).toMatchObject({
    once: true,
    dryRun: true,
  });
});

test("a stray subcommand reaches the daemon as an unknown flag, not a silent no-op", () => {
  expect(() => parseDaemonArguments(["autopilo"])).toThrow("unknown flag: autopilo");
});
