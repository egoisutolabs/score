import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { resolveProjects } from "@score/shared/config/resolve";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assessReadiness } from "./readiness.service";

/**
 * Every case builds a throwaway SCORE_HOME so the probe is exercised
 * against the real layout owners (configPath/resolvedPath/telemetryDir),
 * not mocks — the probe's whole job is reading those files correctly.
 */
function homeConfig(): ScoreConfig {
  return {
    version: 1,
    projects: {
      demo: {
        enabled: true,
        main_location: "/repos/demo",
        worktree_location: "/tmp/wt-demo",
        github_repo: "egoisutolabs/demo",
        config: { agent: { harness: "claude", model: "claude-sonnet-5" } },
      },
      off: {
        enabled: false,
        main_location: "/repos/off",
        worktree_location: "/tmp/wt-off",
        github_repo: "egoisutolabs/off",
        config: { agent: { harness: "claude", model: "claude-sonnet-5" } },
      },
    },
  };
}

async function scoreHome(config: ScoreConfig = homeConfig()): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "score-readyz-"));
  await writeFile(join(home, "config.jsonc"), JSON.stringify(config), "utf8");
  for (const resolved of resolveProjects(config)) {
    const projectDir = join(home, "projects", resolved.key);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "resolved.json"), JSON.stringify(resolved), "utf8");
  }
  return home;
}

async function withSegment(
  home: string,
  key: string,
  segment = "2026-08-15.jsonl",
): Promise<string> {
  const dir = join(home, "projects", key, "telemetry");
  await mkdir(dir, { recursive: true });
  const path = join(dir, segment);
  await writeFile(path, '{"version":1}\n', "utf8");
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assessReadiness", () => {
  test("a fully readable home is ready", async () => {
    const home = await scoreHome();
    await withSegment(home, "demo");
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report).toEqual({
      ready: true,
      checks: [
        { name: "config", ready: true },
        { name: "resolved:demo", ready: true },
        { name: "telemetry:demo", ready: true },
      ],
    });
  });

  test("an unreadable telemetry store flips readiness with a reason code", async () => {
    const home = await scoreHome();
    const dir = await withSegment(home, "demo");
    await chmod(dir, 0o000);
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({
      name: "telemetry:demo",
      ready: false,
      reason_code: "telemetry-unreadable",
    });
    await chmod(dir, 0o755);
  });

  test("a missing resolved config flips only its own check", async () => {
    const home = await scoreHome();
    await withSegment(home, "demo");
    await rm(join(home, "projects", "demo", "resolved.json"));
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({
      name: "resolved:demo",
      ready: false,
      reason_code: "resolved-unreadable",
    });
    expect(report.checks).toContainEqual({ name: "telemetry:demo", ready: true });
  });

  test("an unreadable config short-circuits with the single failing check", async () => {
    const home = await mkdtemp(join(tmpdir(), "score-readyz-"));
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report).toEqual({
      ready: false,
      checks: [{ name: "config", ready: false, reason_code: "config-unreadable" }],
    });
  });

  test("a project with no telemetry yet is still ready", async () => {
    const home = await scoreHome();
    vi.stubEnv("SCORE_HOME", home);
    expect((await assessReadiness()).ready).toBe(true);
  });

  test("disabled projects are never selected", async () => {
    const home = await scoreHome();
    await withSegment(home, "demo");
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.checks.map((check) => check.name)).toEqual([
      "config",
      "resolved:demo",
      "telemetry:demo",
    ]);
  });
});
