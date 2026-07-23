import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScoreConfig } from "@/features/config/model";
import type { JobStatus, SupervisorAdapter } from "@/features/supervisor/adapter";
import { fleetSnapshot } from "@/features/tui/snapshot";

const NOW = Date.parse("2026-07-01T12:00:00.000Z");

function fakeAdapter(jobs: JobStatus[]): SupervisorAdapter {
  return {
    install: async () => {},
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    status: async () => jobs,
  };
}

const config: ScoreConfig = {
  version: 1,
  projects: {
    alpha: {
      enabled: true,
      main_location: "/tmp/alpha",
      worktree_location: "/tmp/wt",
      github_repo: "example/alpha",
      config: { agent: { harness: "claude" } },
    },
  },
};

describe("fleetSnapshot", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "score-snapshot-"));
    process.env.SCORE_HOME = home;
    await mkdir(join(home, "projects", "alpha"), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.SCORE_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("normalizes a partial status.json instead of misreading absent fields", async () => {
    // Only the required fields — an older-schema or hand-edited file.
    await writeFile(
      join(home, "projects", "alpha", "status.json"),
      JSON.stringify({ state: "running", updated_at: new Date(NOW - 1000).toISOString() }),
    );
    const [view] = await fleetSnapshot(
      fakeAdapter([{ key: "alpha", loaded: true, pid: 1 }]),
      config,
      NOW,
    );
    // Absent last_error is not an error, absent tick renders as none.
    expect(view?.status?.last_error).toBeNull();
    expect(view?.status?.tick).toBeNull();
    expect(view?.dot).toBe("green");
  });

  it("falls back to the real defaults for a partial resolved.json", async () => {
    await writeFile(
      join(home, "projects", "alpha", "resolved.json"),
      JSON.stringify({ key: "alpha", agent: { harness: "claude" } }),
    );
    const [view] = await fleetSnapshot(
      fakeAdapter([{ key: "alpha", loaded: true, pid: 1 }]),
      config,
      NOW,
    );
    // The project's actual defaults, not zeros that read as "won't dispatch".
    expect(view?.resolved?.maxParallel).toBe(1);
    expect(view?.resolved?.tickIntervalMs).toBe(60_000);
  });

  it("treats an unreadable status.json as stale, never an error", async () => {
    await writeFile(join(home, "projects", "alpha", "status.json"), "{not json");
    const [view] = await fleetSnapshot(
      fakeAdapter([{ key: "alpha", loaded: true, pid: 1 }]),
      config,
      NOW,
    );
    expect(view?.status).toBeNull();
    expect(view?.dot).toBe("amber");
  });
});
