import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecRunner } from "@score/core/adapters/fixtures/index";
import { afterEach, expect, test } from "vitest";

/**
 * Exercises the repo's own Makefile `verify` recipe — the exact command the
 * landing gate runs on a staged merge tree (#98). The fixture simulates the
 * failure that motivated the change: a merge lands a new workspace package,
 * but the primary checkout never ran `bun install`, so verification fails on
 * unresolvable imports unless the gate installs first.
 */
const scoreMakefile = join(import.meta.dirname, "..", "..", "..", "Makefile");
const runner = new ExecRunner();
const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A merged tree that introduced a workspace package: root `check` imports it,
 * the lockfile knows it, but node_modules was deleted after lockfile
 * generation — the state of a primary checkout that pulled the merge without
 * installing. `check` resolves only if the gate installed first.
 */
async function mergedTreeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "score-verify-gate-"));
  sandboxes.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-root",
      private: true,
      workspaces: ["packages/*"],
      dependencies: { "@score-fixture/newpkg": "workspace:*" },
      scripts: { check: "bun check.ts", test: "true", build: "true" },
    }),
  );
  await writeFile(
    join(root, "check.ts"),
    'import { ok } from "@score-fixture/newpkg";\nif (!ok) throw new Error("not ok");\n',
  );
  await mkdir(join(root, "packages", "newpkg"), { recursive: true });
  await writeFile(
    join(root, "packages", "newpkg", "package.json"),
    JSON.stringify({ name: "@score-fixture/newpkg", exports: { ".": "./index.ts" } }),
  );
  await writeFile(join(root, "packages", "newpkg", "index.ts"), "export const ok = true;\n");
  await writeFile(join(root, ".gitignore"), "node_modules\n");
  const install = await runner.run(["bun", "install"], { cwd: root });
  expect(install.exitCode, install.stderr).toBe(0);
  await rm(join(root, "node_modules"), { recursive: true });
  return root;
}

async function git(root: string, ...args: string[]) {
  const result = await runner.run(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args],
    { cwd: root },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

function makeVerify(root: string) {
  return runner.run(["make", "-f", scoreMakefile, "verify"], { cwd: root });
}

test("verify installs the merged tree's own dependencies before checking (#98)", async () => {
  const root = await mergedTreeFixture();
  await git(root, "init");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "merged tree");
  const lockBefore = await readFile(join(root, "bun.lock"), "utf8");

  const result = await makeVerify(root);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);

  // The gate must leave the checkout byte-identical: lockfile untouched,
  // nothing but ignored node_modules created.
  expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(lockBefore);
  const status = await runner.run(["git", "status", "--porcelain"], { cwd: root });
  expect(status.stdout.trim()).toBe("");
}, 60_000);

test("a drifted lockfile fails verify loudly and is never repaired (#98)", async () => {
  const root = await mergedTreeFixture();
  // The merged tree declares a dependency the lockfile has never seen.
  await mkdir(join(root, "packages", "extra"), { recursive: true });
  await writeFile(
    join(root, "packages", "extra", "package.json"),
    JSON.stringify({ name: "@score-fixture/extra", exports: { ".": "./index.ts" } }),
  );
  await writeFile(join(root, "packages", "extra", "index.ts"), "export const extra = true;\n");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.dependencies["@score-fixture/extra"] = "workspace:*";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const lockBefore = await readFile(join(root, "bun.lock"), "utf8");

  const result = await makeVerify(root);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr + result.stdout).toMatch(/lockfile|frozen/i);
  expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(lockBefore);
}, 60_000);
