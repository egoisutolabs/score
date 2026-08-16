import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The bundle must actually start, not just bundle: the monorepo split once
 * shipped a dist whose flattened workspace imports made every command die on
 * an unresolvable dependency before argv routing, so this boots the built
 * entry and proves argv reaches a command.
 */
test("the built CLI starts and routes argv", () => {
  const build = spawnSync("bun", ["run", "build"], { cwd: packageRoot, encoding: "utf8" });
  expect(build.status).toBe(0);

  const run = spawnSync("bun", ["dist/index.js", "daemon", "--nope"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(run.stderr).toContain("unknown flag: --nope");
  expect(run.status).toBe(2);
});
