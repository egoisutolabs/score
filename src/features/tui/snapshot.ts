import { readFile } from "node:fs/promises";
import { resolvedPath, statusPath } from "@/features/config/layout";
import type { ScoreConfig } from "@/features/config/model";
import { DEFAULT_TICK_INTERVAL_MS } from "@/features/config/resolve";
import type { StatusFile } from "@/features/daemon/status";
import type { JobStatus, SupervisorAdapter } from "@/features/supervisor/adapter";
import { type Dot, deriveDot } from "@/features/tui/dots";

/** The resolved.json values the config pane shows, read best-effort. */
export interface ResolvedView {
  readonly agent: string;
  readonly tickIntervalMs: number;
  readonly maxParallel: number;
}

export interface ProjectView {
  readonly key: string;
  readonly enabled: boolean;
  readonly job: JobStatus | undefined;
  readonly status: StatusFile | null;
  readonly resolved: ResolvedView | null;
  readonly dot: Dot;
}

/**
 * One poll cycle's worth of fleet state: every project in config plus any
 * score-namespace job the supervisor still knows about. Pure reads — the TUI
 * is a disposable viewer, so a missing or garbled file degrades the dot, never
 * crashes the loop.
 */
export async function fleetSnapshot(
  adapter: SupervisorAdapter,
  config: ScoreConfig,
  nowMs: number,
): Promise<ProjectView[]> {
  const jobs = new Map((await adapter.status()).map((job) => [job.key, job]));
  const keys = [...new Set([...Object.keys(config.projects), ...jobs.keys()])].sort();
  return Promise.all(
    keys.map(async (key) => {
      const job = jobs.get(key);
      const status = await readStatusFile(statusPath(key));
      const resolved = await readResolvedView(resolvedPath(key));
      const tickIntervalMs =
        resolved?.tickIntervalMs ??
        config.projects[key]?.config.tick_interval_ms ??
        DEFAULT_TICK_INTERVAL_MS;
      return {
        key,
        enabled: config.projects[key]?.enabled ?? false,
        job,
        status,
        resolved,
        dot: deriveDot({ job, status, tickIntervalMs, nowMs }),
      };
    }),
  );
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // Missing or mid-write — treated as absent.
  }
  return null;
}

async function readStatusFile(path: string): Promise<StatusFile | null> {
  const raw = await readJson(path);
  if (raw === null || typeof raw.state !== "string" || typeof raw.updated_at !== "string") {
    return null;
  }
  // Absent optional fields (older schema, hand edits) normalize to null so a
  // missing last_error never reads as an error and a missing tick renders "-".
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

async function readResolvedView(path: string): Promise<ResolvedView | null> {
  const raw = await readJson(path);
  if (raw === null) return null;
  const agent =
    typeof raw.agent === "object" && raw.agent !== null
      ? (raw.agent as Record<string, unknown>)
      : {};
  const model = typeof agent.model === "string" ? ` · ${agent.model}` : "";
  return {
    agent: `${typeof agent.harness === "string" ? agent.harness : "?"}${model}`,
    tickIntervalMs:
      typeof raw.tickIntervalMs === "number" ? raw.tickIntervalMs : DEFAULT_TICK_INTERVAL_MS,
    maxParallel: typeof raw.maxParallel === "number" ? raw.maxParallel : 0,
  };
}
