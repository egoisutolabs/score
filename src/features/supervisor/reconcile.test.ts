import { expect, test } from "vitest";
import type { ResolvedProject } from "@/features/config/model";
import type { JobStatus } from "@/features/supervisor/adapter";
import { plan } from "@/features/supervisor/reconcile";

function project(key: string, overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    key,
    mainLocation: `/repos/${key}`,
    worktreeLocation: `/wt/${key}`,
    githubRepo: `egoisutolabs/${key}`,
    tickIntervalMs: 1000,
    maxParallel: 1,
    agent: { harness: "claude", model: "claude-sonnet-5" },
    autoMerge: true,
    logRetentionDays: 30,
    configHash: `hash-${key}`,
    ...overrides,
  };
}

function loaded(key: string): JobStatus {
  return { key, loaded: true, pid: 42 };
}

function existing(...projects: ResolvedProject[]): Map<string, ResolvedProject> {
  return new Map(projects.map((entry) => [entry.key, entry]));
}

test("a desired project with no job starts", () => {
  const decided = plan([project("a")], [], existing());
  expect(decided.start.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.restart).toEqual([]);
  expect(decided.unchanged).toEqual([]);
  expect(decided.removed).toEqual([]);
  expect(decided.refused).toEqual([]);
});

test("a loaded job with the same hash is unchanged", () => {
  const decided = plan([project("a")], [loaded("a")], existing(project("a")));
  expect(decided.unchanged.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.start).toEqual([]);
  expect(decided.restart).toEqual([]);
});

test("a loaded job with a different hash restarts", () => {
  const decided = plan(
    [project("a", { configHash: "hash-new" })],
    [loaded("a")],
    existing(project("a")),
  );
  expect(decided.restart.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.unchanged).toEqual([]);
});

test("a loaded job with no readable resolved.json restarts", () => {
  const decided = plan([project("a")], [loaded("a")], existing());
  expect(decided.restart.map((entry) => entry.key)).toEqual(["a"]);
});

test("a job absent from config is removed, never stopped by plan", () => {
  const decided = plan([], [loaded("gone")], existing(project("gone")));
  expect(decided.removed).toEqual(["gone"]);
  expect(decided.start).toEqual([]);
  expect(decided.restart).toEqual([]);
});

test("a definition-only job (not loaded) still reports as removed when unconfigured", () => {
  const decided = plan([], [{ key: "stale", loaded: false }], existing());
  expect(decided.removed).toEqual(["stale"]);
});

test("a desired project whose job is definition-only starts", () => {
  const decided = plan([project("a")], [{ key: "a", loaded: false }], existing(project("a")));
  expect(decided.start.map((entry) => entry.key)).toEqual(["a"]);
});

test("rename a→b: b is refused naming a, a is removed, nothing starts", () => {
  const decided = plan(
    [project("b", { mainLocation: "/repos/a" })],
    [loaded("a")],
    existing(project("a")),
  );
  expect(decided.refused).toEqual([
    { project: expect.objectContaining({ key: "b" }), blockingKey: "a" },
  ]);
  expect(decided.start).toEqual([]);
  expect(decided.restart).toEqual([]);
  expect(decided.removed).toEqual(["a"]);
});

test("copy-paste collision: second key on a running checkout is refused", () => {
  const decided = plan(
    [project("a"), project("b", { mainLocation: "/repos/a" })],
    [loaded("a")],
    existing(project("a")),
  );
  expect(decided.unchanged.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.refused).toEqual([
    { project: expect.objectContaining({ key: "b" }), blockingKey: "a" },
  ]);
});

test("two fresh projects sharing a checkout: only the first starts", () => {
  const decided = plan([project("a"), project("b", { mainLocation: "/repos/a" })], [], existing());
  expect(decided.start.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.refused).toEqual([
    { project: expect.objectContaining({ key: "b" }), blockingKey: "a" },
  ]);
});

test("a loaded job with unreadable resolved.json still claims its checkout via config", () => {
  // b listed before a in config, a loaded but its resolved.json unreadable:
  // b must be refused (blocking a), a restarts — never the inverse.
  const decided = plan(
    [
      project("b", { mainLocation: "/repos/shared" }),
      project("a", { mainLocation: "/repos/shared" }),
    ],
    [loaded("a")],
    existing(),
  );
  expect(decided.refused).toEqual([
    { project: expect.objectContaining({ key: "b" }), blockingKey: "a" },
  ]);
  expect(decided.start).toEqual([]);
  expect(decided.restart.map((entry) => entry.key)).toEqual(["a"]);
});

test("distinct checkouts never collide", () => {
  const decided = plan([project("a"), project("b")], [loaded("a")], existing(project("a")));
  expect(decided.refused).toEqual([]);
  expect(decided.unchanged.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.start.map((entry) => entry.key)).toEqual(["b"]);
});

test("a loaded job with unknowable checkout fails closed: new starts are refused", () => {
  // ghost is loaded but has no resolved.json and no config entry — it could be
  // sitting on any checkout, so nothing new starts until it is downed.
  const decided = plan([project("a")], [loaded("ghost")], existing());
  expect(decided.refused).toEqual([
    { project: expect.objectContaining({ key: "a" }), blockingKey: "ghost", unknownState: true },
  ]);
  expect(decided.start).toEqual([]);
  expect(decided.removed).toEqual(["ghost"]);
});

test("an unknowable job does not block restarts of already-supervised keys", () => {
  const decided = plan(
    [project("a", { configHash: "hash-new" })],
    [loaded("a"), loaded("ghost")],
    existing(project("a")),
  );
  expect(decided.restart.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.refused).toEqual([]);
});

test("claims compare canonical paths, so symlink spellings of one checkout collide", () => {
  const canonicalize = (path: string): string => path.replace("/link/", "/real/");
  const decided = plan(
    [
      project("a", { mainLocation: "/real/shared" }),
      project("b", { mainLocation: "/link/shared" }),
    ],
    [],
    existing(),
    canonicalize,
  );
  expect(decided.start.map((entry) => entry.key)).toEqual(["a"]);
  expect(decided.refused).toEqual([
    { project: expect.objectContaining({ key: "b" }), blockingKey: "a" },
  ]);
});
