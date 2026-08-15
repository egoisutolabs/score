import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { resolveProjects } from "@score/shared/config/resolve";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assessReadiness } from "./readiness";

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

  // Root ignores mode bits, so permission-based unreadability only bites
  // unprivileged runners; the file-occupancy test below is the root-proof one.
  const unprivileged = (process.getuid?.() ?? 0) !== 0;
  test.skipIf(!unprivileged)(
    "an unreadable telemetry store flips readiness with a reason code",
    async () => {
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
    },
  );

  test("a store occupied by a regular file is unreadable even for root", async () => {
    // chmod-based unreadability evaporates under a root runner, so the
    // portable proof uses a file where the directory belongs — no
    // permission bit is honored, the shape itself is wrong.
    const home = await scoreHome();
    await writeFile(join(home, "projects", "demo", "telemetry"), "not a store", "utf8");
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({
      name: "telemetry:demo",
      ready: false,
      reason_code: "telemetry-unreadable",
    });
  });

  test("a directory named like a segment is not readable telemetry", async () => {
    // Opening a directory succeeds on Linux, but the reader's readFileSync
    // takes EISDIR — the probe must require a regular file, whatever uid.
    const home = await scoreHome();
    const dir = join(home, "projects", "demo", "telemetry");
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, "2026-08-15.jsonl"));
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({
      name: "telemetry:demo",
      ready: false,
      reason_code: "telemetry-unreadable",
    });
  });

  // A FIFO at a segment path blocks a plain open forever — the probe must
  // reject it by entry type, never by trying to read it. CI runners are
  // Unix; where mkfifo is absent there is nothing to prove here. (BSD
  // mkfifo rejects --version, so probe availability with command -v.)
  const hasMkfifo = (() => {
    try {
      execFileSync("sh", ["-c", "command -v mkfifo"]);
      return true;
    } catch {
      return false;
    }
  })();
  test.skipIf(!hasMkfifo)(
    "a FIFO named like a segment flips readiness without hanging",
    async () => {
      const home = await scoreHome();
      const dir = join(home, "projects", "demo", "telemetry");
      await mkdir(dir, { recursive: true });
      execFileSync("mkfifo", [join(dir, "2026-08-15.jsonl")]);
      vi.stubEnv("SCORE_HOME", home);
      const report = await assessReadiness();
      expect(report.ready).toBe(false);
      expect(report.checks).toContainEqual({
        name: "telemetry:demo",
        ready: false,
        reason_code: "telemetry-unreadable",
      });
    },
  );

  // A dangling symlink at the store path is not an empty store: the name
  // is occupied (writer mkdir takes EEXIST), so readiness must flip even
  // though stat reports ENOENT — the empty-store allowance is for absent
  // paths only.
  test("a dangling symlink at the telemetry dir flips readiness", async () => {
    const home = await scoreHome();
    await mkdir(join(home, "projects", "demo"), { recursive: true });
    await symlink(
      join(home, "projects", "demo", "no-such-store"),
      join(home, "projects", "demo", "telemetry"),
    );
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({
      name: "telemetry:demo",
      ready: false,
      reason_code: "telemetry-unreadable",
    });
  });

  // A dangling symlink at a segment path still occupies the name — the
  // reader's snapshot includes it and expires cursors, so it is corruption,
  // not retention. Symlinks exist wherever this suite runs (CI is Unix).
  test("a dangling symlink at a segment path flips readiness", async () => {
    const home = await scoreHome();
    const dir = join(home, "projects", "demo", "telemetry");
    await mkdir(dir, { recursive: true });
    await symlink(join(dir, "no-such-target"), join(dir, "2026-08-15.jsonl"));
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({
      name: "telemetry:demo",
      ready: false,
      reason_code: "telemetry-unreadable",
    });
  });

  // Metadata is not readability: /proc/self/mem is a regular file that
  // opens and fstats fine yet fails the read (EIO). Present on Linux only.
  const hasProcMem = existsSync("/proc/self/mem");
  test.skipIf(!hasProcMem)("a segment whose bytes cannot be read flips readiness", async () => {
    const home = await scoreHome();
    const dir = join(home, "projects", "demo", "telemetry");
    await mkdir(dir, { recursive: true });
    await symlink("/proc/self/mem", join(dir, "2026-08-15.jsonl"));
    vi.stubEnv("SCORE_HOME", home);
    const report = await assessReadiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual({
      name: "telemetry:demo",
      ready: false,
      reason_code: "telemetry-unreadable",
    });
  });

  // readFile blocks forever on a FIFO: the probe must reject these entries
  // by type before loadConfig/readResolvedProject are ever called.
  test.skipIf(!hasMkfifo)(
    "a FIFO at config.jsonc flips the config check without hanging",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "score-readyz-"));
      execFileSync("mkfifo", [join(home, "config.jsonc")]);
      vi.stubEnv("SCORE_HOME", home);
      const report = await assessReadiness();
      expect(report).toEqual({
        ready: false,
        checks: [{ name: "config", ready: false, reason_code: "config-unreadable" }],
      });
    },
  );

  test.skipIf(!hasMkfifo)("a FIFO at resolved.json flips only that project's check", async () => {
    const home = await scoreHome();
    await withSegment(home, "demo");
    await rm(join(home, "projects", "demo", "resolved.json")); // mkfifo needs the slot
    execFileSync("mkfifo", [join(home, "projects", "demo", "resolved.json")]);
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

  // Root ignores mode bits, so the open-probe proof only bites unprivileged.
  test.skipIf(!unprivileged)(
    "a traversable dir over an unopenable segment is not ready",
    async () => {
      const home = await scoreHome();
      const dir = await withSegment(home, "demo");
      await chmod(join(dir, "2026-08-15.jsonl"), 0o000);
      vi.stubEnv("SCORE_HOME", home);
      const report = await assessReadiness();
      expect(report.ready).toBe(false);
      expect(report.checks).toContainEqual({
        name: "telemetry:demo",
        ready: false,
        reason_code: "telemetry-unreadable",
      });
    },
  );

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
