import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { ManagedChild } from "@score/agents/opencode-server.service";
import { bufferStdout, OpencodeServer } from "@score/agents/opencode-server.service";
import { afterEach, expect, test } from "vitest";

const fixtureDir = fileURLToPath(new URL(".", import.meta.url));
const fixture = (name: string) => join(fixtureDir, `opencode-server-${name}.fixture.ts`);

const happy = fixture("happy");
const neverDoc = fixture("never-doc");
const noUrl = fixture("no-url");
const exitEarly = fixture("exit-early");
const exitAfterReady = fixture("exit-after-ready");
const ignoreSigterm = fixture("ignore-sigterm");

// Safety net: whatever a test's own assertions find, no stub survives the run.
afterEach(() => {
  try {
    execFileSync("pkill", ["-9", "-f", join(fixtureDir, "opencode-server-")]);
  } catch {
    // pkill exits non-zero when nothing matched; nothing to clean up.
  }
});

function livePidsFor(fixturePath: string): number[] {
  try {
    const output = execFileSync("pgrep", ["-f", fixturePath], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) return [];
    throw error;
  }
}

async function waitUntilGone(fixturePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (livePidsFor(fixturePath).length > 0) {
    if (Date.now() > deadline) {
      throw new Error(`${fixturePath} still has live pids: ${livePidsFor(fixturePath)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeManagedChild(): ManagedChild {
  const stdout = new Readable({ read() {} });
  return {
    process: { stdout } as ManagedChild["process"],
    exited: new Promise(() => {}),
    hasExited: () => false,
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("bufferStdout drops retained text once stopBuffering() is called", async () => {
  const managed = fakeManagedChild();
  const stdout = bufferStdout(managed);
  managed.process.stdout.push("opencode server listening on http://127.0.0.1:1\n");
  await nextTick();
  expect(stdout.read()).toBe("opencode server listening on http://127.0.0.1:1\n");

  stdout.stopBuffering();
  expect(stdout.read()).toBe("");

  // A long-lived child's later stdout (request logs, debug noise) must not
  // grow the buffer back — the listener stays attached only to drain the
  // pipe, per the regression this test guards against.
  managed.process.stdout.push("request log line\n".repeat(1_000));
  await nextTick();
  expect(stdout.read()).toBe("");
});

test("start() resolves with the base URL a happy stub prints", async () => {
  const server = new OpencodeServer({
    executable: happy,
    startupDeadlineMs: 2_000,
    stopGraceMs: 300,
  });
  const handle = await server.start();
  expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await handle.stop();
  await waitUntilGone(happy);
});

test("start() rejects within the deadline when /doc never answers, and kills the stub", async () => {
  const server = new OpencodeServer({
    executable: neverDoc,
    startupDeadlineMs: 300,
    stopGraceMs: 300,
  });
  const startedAt = Date.now();
  await expect(server.start()).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  await waitUntilGone(neverDoc);
});

test("start() rejects within the deadline when the stub never prints a URL, and kills the stub", async () => {
  const server = new OpencodeServer({
    executable: noUrl,
    startupDeadlineMs: 300,
    stopGraceMs: 300,
  });
  const startedAt = Date.now();
  await expect(server.start()).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  await waitUntilGone(noUrl);
});

test("start() rejects when the stub exits before printing a URL", async () => {
  const server = new OpencodeServer({
    executable: exitEarly,
    startupDeadlineMs: 2_000,
    stopGraceMs: 300,
  });
  await expect(server.start()).rejects.toThrow();
  await waitUntilGone(exitEarly);
});

test("a stub that exits after readiness settles the unexpected-exit signal", async () => {
  const server = new OpencodeServer({
    executable: exitAfterReady,
    startupDeadlineMs: 2_000,
    stopGraceMs: 300,
  });
  const handle = await server.start();
  await expect(
    Promise.race([
      handle.unexpectedExit.then(() => "fired"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
    ]),
  ).resolves.toBe("fired");
  await waitUntilGone(exitAfterReady);
});

test("stop() called first means a subsequent exit never fires the unexpected-exit signal", async () => {
  const server = new OpencodeServer({
    executable: happy,
    startupDeadlineMs: 2_000,
    stopGraceMs: 300,
  });
  const handle = await server.start();
  await handle.stop();
  await expect(
    Promise.race([
      handle.unexpectedExit.then(() => "fired"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 300)),
    ]),
  ).resolves.toBe("timed-out");
  await waitUntilGone(happy);
});

test("stop() escalates to SIGKILL within the stop bound when the stub ignores SIGTERM", async () => {
  const server = new OpencodeServer({
    executable: ignoreSigterm,
    startupDeadlineMs: 2_000,
    stopGraceMs: 300,
  });
  const handle = await server.start();
  const stoppedAt = Date.now();
  await handle.stop();
  const elapsed = Date.now() - stoppedAt;
  expect(elapsed).toBeGreaterThanOrEqual(300);
  expect(elapsed).toBeLessThan(2_000);
  await waitUntilGone(ignoreSigterm);
});

test("stop() is idempotent for concurrent and sequential calls, killing at most once", async () => {
  const server = new OpencodeServer({
    executable: happy,
    startupDeadlineMs: 2_000,
    stopGraceMs: 300,
  });
  await server.start();
  await Promise.all([server.stop(), server.stop()]);
  await server.stop();
  await waitUntilGone(happy);
});

test("stop() during starting aborts the readiness wait and kills the child", async () => {
  const server = new OpencodeServer({
    executable: noUrl,
    startupDeadlineMs: 5_000,
    stopGraceMs: 300,
  });
  const startPromise = server.start();
  const startedAt = Date.now();
  const stopPromise = server.stop();
  await expect(startPromise).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  await stopPromise;
  await waitUntilGone(noUrl);
});

test("constructor rejects a non-positive startup deadline", () => {
  expect(() => new OpencodeServer({ startupDeadlineMs: 0 })).toThrow();
  expect(() => new OpencodeServer({ startupDeadlineMs: -1 })).toThrow();
});

test("constructor rejects a non-positive stop grace", () => {
  expect(() => new OpencodeServer({ stopGraceMs: 0 })).toThrow();
  expect(() => new OpencodeServer({ stopGraceMs: -1 })).toThrow();
});
