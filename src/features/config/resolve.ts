import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedProject, ScoreConfig } from "@/features/config/model";

export const DEFAULT_TICK_INTERVAL_MS = 60_000;
export const DEFAULT_MAX_PARALLEL = 1;
export const DEFAULT_AUTO_MERGE = true;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

/** Enabled projects only, tilde-expanded, defaults applied, hashed on resolved values. */
export function resolveProjects(config: ScoreConfig): ResolvedProject[] {
  const logRetentionDays = config.log_retention_days ?? DEFAULT_LOG_RETENTION_DAYS;
  const resolved: ResolvedProject[] = [];
  for (const [key, project] of Object.entries(config.projects)) {
    if (!project.enabled) continue;
    const bare: Omit<ResolvedProject, "configHash"> = {
      key,
      mainLocation: expandTilde(project.main_location),
      worktreeLocation: expandTilde(project.worktree_location),
      githubRepo: project.github_repo,
      tickIntervalMs: project.config.tick_interval_ms ?? DEFAULT_TICK_INTERVAL_MS,
      maxParallel: project.config.max_parallel ?? DEFAULT_MAX_PARALLEL,
      agent: { harness: project.config.agent.harness, model: project.config.agent.model },
      autoMerge: project.config.auto_merge ?? DEFAULT_AUTO_MERGE,
      logRetentionDays,
    };
    resolved.push({ ...bare, configHash: configHash(bare) });
  }
  return resolved;
}

/** sha256 of the value serialized with sorted keys — stable across key order. */
export function configHash(value: unknown): string {
  return createHash("sha256").update(sortedJson(value)).digest("hex");
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
