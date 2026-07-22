import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ProjectConfig, ScoreConfig } from "@/features/config/model";
import { resolveProjects } from "@/features/config/resolve";

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    enabled: true,
    main_location: "~/Desktop/build-week/score",
    worktree_location: "~/wt/score",
    github_repo: "egoisutolabs/score",
    config: { agent: { harness: "claude", model: "claude-sonnet-5" } },
    ...overrides,
  };
}

function config(projects: Record<string, ProjectConfig>, retention?: number): ScoreConfig {
  return {
    version: 1,
    ...(retention !== undefined && { log_retention_days: retention }),
    projects,
  };
}

test("tilde paths expand to absolute paths under the real home", () => {
  const [resolved] = resolveProjects(config({ score: project() }));
  expect(resolved?.mainLocation).toBe(join(homedir(), "Desktop/build-week/score"));
  expect(resolved?.worktreeLocation).toBe(join(homedir(), "wt/score"));
  expect(resolved?.mainLocation.startsWith("/")).toBe(true);
});

test("defaults apply: tick 60000, max_parallel 1, auto_merge true, retention 30", () => {
  const [resolved] = resolveProjects(config({ score: project() }));
  expect(resolved?.tickIntervalMs).toBe(60_000);
  expect(resolved?.maxParallel).toBe(1);
  expect(resolved?.autoMerge).toBe(true);
  expect(resolved?.logRetentionDays).toBe(30);
});

test("explicit values override defaults", () => {
  const [resolved] = resolveProjects(
    config(
      {
        score: project({
          config: {
            tick_interval_ms: 5000,
            max_parallel: 3,
            auto_merge: false,
            agent: { harness: "claude", model: "claude-opus-4-8" },
          },
        }),
      },
      7,
    ),
  );
  expect(resolved?.tickIntervalMs).toBe(5000);
  expect(resolved?.maxParallel).toBe(3);
  expect(resolved?.autoMerge).toBe(false);
  expect(resolved?.logRetentionDays).toBe(7);
  expect(resolved?.agent.model).toBe("claude-opus-4-8");
});

test("disabled projects are excluded", () => {
  const resolved = resolveProjects(config({ off: project({ enabled: false }), on: project() }));
  expect(resolved.map((p) => p.key)).toEqual(["on"]);
});

test("empty projects resolves to []", () => {
  expect(resolveProjects(config({}))).toEqual([]);
});

test("config_hash is stable across project key order", () => {
  const a = resolveProjects(config({ one: project(), two: project() }));
  const b = resolveProjects(config({ two: project(), one: project() }));
  const hashOf = (list: typeof a, key: string) => list.find((p) => p.key === key)?.configHash;
  expect(hashOf(a, "one")).toBe(hashOf(b, "one"));
  expect(hashOf(a, "two")).toBe(hashOf(b, "two"));
});

test("config_hash changes when any resolved value changes", () => {
  const base = resolveProjects(config({ score: project() }))[0]?.configHash;
  const changedTick = resolveProjects(
    config({
      score: project({
        config: { tick_interval_ms: 1000, agent: { harness: "claude", model: "claude-sonnet-5" } },
      }),
    }),
  )[0]?.configHash;
  const changedRepo = resolveProjects(
    config({ score: project({ github_repo: "egoisutolabs/other" }) }),
  )[0]?.configHash;
  const changedRetention = resolveProjects(config({ score: project() }, 7))[0]?.configHash;
  expect(changedTick).not.toBe(base);
  expect(changedRepo).not.toBe(base);
  expect(changedRetention).not.toBe(base);
});

test("config_hash is unchanged when only an unresolved detail (key order in source) differs", () => {
  const reordered: ProjectConfig = JSON.parse(
    JSON.stringify({
      github_repo: "egoisutolabs/score",
      config: { agent: { model: "claude-sonnet-5", harness: "claude" } },
      worktree_location: "~/wt/score",
      main_location: "~/Desktop/build-week/score",
      enabled: true,
    }),
  );
  const base = resolveProjects(config({ score: project() }))[0]?.configHash;
  const same = resolveProjects(config({ score: reordered }))[0]?.configHash;
  expect(same).toBe(base);
});
