import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = fileURLToPath(new URL("./managed-loop.fixture.ts", import.meta.url));

const sandboxes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Fixture {
  readonly child: ChildProcess;
  readonly statusPath: string;
  stdout(): string;
  waitFor(text: string): Promise<void>;
  exited(): Promise<number | null>;
}

async function startFixture(mode: "sleep" | "midpass"): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "score-managed-loop-"));
  sandboxes.push(dir);
  const statusPath = join(dir, "status.json");
  // cwd = project root so bun resolves the "@/*" tsconfig paths.
  const child = spawn("bun", [fixture, mode, statusPath], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let errors = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    errors += chunk;
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return {
    child,
    statusPath,
    stdout: () => output,
    waitFor: async (text) => {
      const deadline = Date.now() + 10_000;
      while (!output.includes(text)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for "${text}"; stdout: ${output}; stderr: ${errors}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    exited: () => exit,
  };
}

async function readStatus(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("SIGTERM during the idle sleep exits 0 in under a second", async () => {
  const fx = await startFixture("sleep");
  await fx.waitFor("pass 0 end");
  const signaledAt = Date.now();
  fx.child.kill("SIGTERM");
  const code = await fx.exited();
  expect(Date.now() - signaledAt).toBeLessThan(1_000);
  expect(code).toBe(0);
  expect(fx.stdout()).toContain("clean exit");
  expect(await readStatus(fx.statusPath)).toMatchObject({ state: "stopping" });
}, 20_000);

test("SIGTERM mid-pass finishes the current phase, skips the rest, exits 0", async () => {
  const fx = await startFixture("midpass");
  await fx.waitFor("phase one start");
  fx.child.kill("SIGTERM");
  const code = await fx.exited();
  expect(code).toBe(0);
  const output = fx.stdout();
  // The in-flight phase completes; nothing after it starts.
  expect(output).toContain("phase one done");
  expect(output).not.toContain("phase two start");
  expect(output).toContain("pass 0 end");
  expect(output).toContain("clean exit");
  expect(await readStatus(fx.statusPath)).toMatchObject({ state: "stopping" });
}, 20_000);

test("a second SIGTERM is idempotent", async () => {
  const fx = await startFixture("midpass");
  await fx.waitFor("phase one start");
  fx.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 50));
  fx.child.kill("SIGTERM");
  const code = await fx.exited();
  expect(code).toBe(0);
  expect(fx.stdout()).toContain("clean exit");
  expect(await readStatus(fx.statusPath)).toMatchObject({ state: "stopping" });
}, 20_000);
