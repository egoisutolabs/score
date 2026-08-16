/**
 * Subscribe-time snapshots from the live owners: config keys, resolved.json,
 * status.json, and SupervisorAdapter.status() — never the telemetry log
 * (evidence is never truth, locked decision 11). Snapshots are built once
 * per subscribe and never refreshed mid-stream; a reconnect gets fresh
 * ones. Every field emitted is an allowlisted copy — absolute paths
 * (mainLocation, worktreeLocation) and free error text never leave the box.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusFile } from "@score/core/daemon/status.service";
import type { Health } from "@score/core/observation/health.policy";
import { healthFor } from "@score/core/observation/health.policy";
import type { JobStatus } from "@score/core/observation/jobs.service";
import type { TelemetryCursor } from "@score/core/telemetry/telemetry.interface";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { DEFAULT_MAX_PARALLEL, DEFAULT_TICK_INTERVAL_MS } from "@score/shared/config/resolve";

/** The resolved.json values safe to emit; everything else stays on disk. */
export interface SnapshotConfigView {
  readonly harness: string | null;
  readonly model: string | null;
  readonly tick_interval_ms: number;
  readonly max_parallel: number;
}

/**
 * status.json minus last_error/last_gate_failure: their free text can embed
 * absolute paths and raw gate output, which never enter API payloads — the
 * health reasons already carry the crashed/stale verdict those fields feed.
 */
export interface SnapshotStatusView {
  readonly state: StatusFile["state"];
  readonly pid: number;
  readonly tick: number | null;
  readonly last_pass_started_at: string | null;
  readonly last_pass_completed_at: string | null;
  readonly updated_at: string;
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
  /** False adds a CONFIG_UNPARSEABLE warning to the fleet snapshot. */
  readonly configReadable: boolean;
  readonly projects: readonly ProjectObservation[];
}

export interface FleetObservationDeps {
  readonly projectsDir: string;
  readonly readConfig: () => Promise<ScoreConfig | null>;
  readonly jobs: () => Promise<readonly JobStatus[]>;
}

/**
 * One subscribe's worth of owner reads. Membership is the union of config
 * keys, supervisor jobs, and project state dirs — a decommissioned config
 * entry with surviving segments still replays, a config-only project still
 * appears as disabled/stopped. Every read degrades to null, never throws:
 * the stream is a disposable viewer of files another process owns.
 */
export async function observeFleet(
  deps: FleetObservationDeps,
  nowMs: number,
): Promise<FleetObservation> {
  const config = await deps.readConfig().catch(() => null);
  const jobs = new Map((await deps.jobs().catch(() => [])).map((job) => [job.key, job]));
  const keys = [
    ...new Set([
      ...Object.keys(config?.projects ?? {}),
      ...jobs.keys(),
      ...listProjectDirs(deps.projectsDir),
    ]),
  ].sort();
  return {
    keys,
    configReadable: config !== null,
    projects: keys.map((key) => {
      const job = jobs.get(key);
      const status = readStatusFile(join(deps.projectsDir, key, "status.json"));
      const resolved = readConfigView(join(deps.projectsDir, key, "resolved.json"));
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

export interface FleetSnapshotData {
  readonly projects: readonly {
    readonly project: string;
    readonly enabled: boolean | null;
    readonly health: Health;
  }[];
}

export function fleetSnapshotData(observation: FleetObservation): FleetSnapshotData {
  return {
    projects: observation.projects.map((project) => ({
      project: project.key,
      enabled: project.enabled,
      health: project.health,
    })),
  };
}

export interface ProjectSnapshotData {
  readonly project: string;
  readonly enabled: boolean | null;
  readonly supervisor: { readonly loaded: boolean; readonly pid?: number } | null;
  readonly status: SnapshotStatusView | null;
  readonly config: SnapshotConfigView | null;
  readonly health: Health;
  /** The replay high-water positions captured for this project at subscribe. */
  readonly telemetry_watermark: readonly Omit<TelemetryCursor, "project">[];
}

export function projectSnapshotData(
  project: ProjectObservation,
  watermark: readonly TelemetryCursor[],
): ProjectSnapshotData {
  return {
    project: project.key,
    enabled: project.enabled,
    supervisor:
      project.job === undefined
        ? null
        : {
            loaded: project.job.loaded,
            ...(project.job.pid !== undefined && { pid: project.job.pid }),
          },
    status:
      project.status === null
        ? null
        : {
            state: project.status.state,
            pid: project.status.pid,
            tick: project.status.tick,
            last_pass_started_at: project.status.last_pass_started_at,
            last_pass_completed_at: project.status.last_pass_completed_at,
            updated_at: project.status.updated_at,
          },
    config: project.config,
    health: project.health,
    telemetry_watermark: watermark.map(({ source, segment, byte_offset }) => ({
      source,
      segment,
      byte_offset,
    })),
  };
}

function listProjectDirs(projectsDir: string): readonly string[] {
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
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
