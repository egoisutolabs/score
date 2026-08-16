/**
 * Subscribe-time owner reads: config keys, resolved.json, status.json, and
 * the supervisor job table through core's read-only observation seam — never
 * the telemetry log (evidence is never truth, locked decision 11). One
 * observation per subscribe, never refreshed mid-stream; a reconnect gets a
 * fresh one. Payload shaping lives in snapshot.render.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusFile } from "@score/core/daemon/status.service";
import type { Health } from "@score/core/observation/health.policy";
import { healthFor } from "@score/core/observation/health.policy";
import type { JobStatus } from "@score/core/observation/jobs.service";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { DEFAULT_MAX_PARALLEL, DEFAULT_TICK_INTERVAL_MS } from "@score/shared/config/resolve";

/** The resolved.json values safe to emit; everything else stays on disk. */
export interface SnapshotConfigView {
  readonly harness: string | null;
  readonly model: string | null;
  readonly tick_interval_ms: number;
  readonly max_parallel: number;
}

export interface ProjectObservation {
  readonly key: string;
  /** Null when config.jsonc is unreadable or does not name this project. */
  readonly enabled: boolean | null;
  readonly job: JobStatus | undefined;
  readonly status: StatusFile | null;
  readonly config: SnapshotConfigView | null;
  readonly health: Health;
}

export interface FleetObservation {
  readonly keys: readonly string[];
  /** False adds a CONFIG_UNPARSEABLE warning to the snapshots. */
  readonly configReadable: boolean;
  /** False adds a SUPERVISOR_UNREADABLE warning — job facts are unknown, not absent. */
  readonly jobsReadable: boolean;
  readonly projects: readonly ProjectObservation[];
}

export interface SnapshotDeps {
  readonly projectsDir: string;
  readonly readConfig: () => Promise<ScoreConfig | null>;
  readonly jobs: () => Promise<readonly JobStatus[] | null>;
}

/**
 * One subscribe's worth of owner reads. Membership is the union of config
 * keys, supervisor jobs, and project state dirs — a decommissioned config
 * entry with surviving segments still replays, a config-only project still
 * appears as disabled/stopped. Every read degrades to null with an explicit
 * flag, never throws: the stream is a disposable viewer of files another
 * process owns.
 */
export class SnapshotService {
  constructor(private readonly deps: SnapshotDeps) {}

  async observe(nowMs: number): Promise<FleetObservation> {
    const config = await this.deps.readConfig().catch(() => null);
    const jobList = await this.deps.jobs().catch(() => null);
    const jobs = new Map((jobList ?? []).map((job) => [job.key, job]));
    const keys = [
      ...new Set([
        ...Object.keys(config?.projects ?? {}),
        ...jobs.keys(),
        ...this.listProjectDirs(),
      ]),
    ].sort();
    return {
      keys,
      configReadable: config !== null,
      jobsReadable: jobList !== null,
      projects: keys.map((key) => {
        const job = jobs.get(key);
        const status = readStatusFile(join(this.deps.projectsDir, key, "status.json"));
        const resolved = readConfigView(join(this.deps.projectsDir, key, "resolved.json"));
        const tickIntervalMs =
          resolved?.tick_interval_ms ??
          config?.projects[key]?.config.tick_interval_ms ??
          DEFAULT_TICK_INTERVAL_MS;
        return {
          key,
          enabled: config === null ? null : (config.projects[key]?.enabled ?? null),
          job,
          status,
          config: resolved,
          health: healthFor({ job, status, tickIntervalMs, nowMs }),
        };
      }),
    };
  }

  private listProjectDirs(): readonly string[] {
    try {
      return readdirSync(this.deps.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // Missing or mid-write — absent, same as the TUI's read.
  }
  return null;
}

function readStatusFile(path: string): StatusFile | null {
  const raw = readJson(path);
  if (raw === null || typeof raw.state !== "string" || typeof raw.updated_at !== "string") {
    return null;
  }
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    state: raw.state as StatusFile["state"],
    pid: typeof raw.pid === "number" ? raw.pid : 0,
    tick: typeof raw.tick === "number" ? raw.tick : null,
    last_pass_started_at: text(raw.last_pass_started_at),
    last_pass_completed_at: text(raw.last_pass_completed_at),
    last_error: text(raw.last_error),
    last_gate_failure: text(raw.last_gate_failure),
    updated_at: raw.updated_at,
  };
}

function readConfigView(path: string): SnapshotConfigView | null {
  const raw = readJson(path);
  if (raw === null) return null;
  const agent =
    typeof raw.agent === "object" && raw.agent !== null
      ? (raw.agent as Record<string, unknown>)
      : {};
  return {
    harness: typeof agent.harness === "string" ? agent.harness : null,
    model: typeof agent.model === "string" ? agent.model : null,
    tick_interval_ms:
      typeof raw.tickIntervalMs === "number" ? raw.tickIntervalMs : DEFAULT_TICK_INTERVAL_MS,
    max_parallel: typeof raw.maxParallel === "number" ? raw.maxParallel : DEFAULT_MAX_PARALLEL,
  };
}
