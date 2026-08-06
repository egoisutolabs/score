import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import { expect, test } from "vitest";

test("every command is bounded by the default deadline, no opt-in required", async () => {
  const runner = new BunCommandRunner({ defaultTimeoutMs: 150, killGraceMs: 100 });
  const started = Date.now();
  const result = await runner.run(["sleep", "5"], { cwd: "/tmp" });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("an explicit per-call timeout overrides the default", async () => {
  const runner = new BunCommandRunner({ defaultTimeoutMs: 60_000, killGraceMs: 100 });
  const result = await runner.run(["sleep", "5"], { cwd: "/tmp", timeoutMs: 150 });
  expect(result.timedOut).toBe(true);
});

test("a well-behaved command is untouched by the deadline", async () => {
  const runner = new BunCommandRunner({ defaultTimeoutMs: 5_000 });
  const result = await runner.run(["echo", "ok"], { cwd: "/tmp" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
  expect(result.timedOut).toBe(false);
});

test("an orphan holding the output pipe cannot hang the runner past the hard stop", async () => {
  // sh dies on SIGTERM, but its TERM-immune subshell survives even the
  // follow-up SIGKILL (which targets the direct child only) and keeps our
  // stdout pipe open — exactly the shape of a wedged `sh -c "make verify"`.
  const runner = new BunCommandRunner({ defaultTimeoutMs: 150, killGraceMs: 150 });
  const started = Date.now();
  const result = await runner.run(["sh", "-c", "(trap '' TERM; sleep 5) & wait"], { cwd: "/tmp" });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_500);
});
