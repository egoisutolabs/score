import type { ResolvedProject } from "@/features/config/model";
import type { JobStatus } from "@/features/supervisor/adapter";

/** Decision 12: a project refused because its checkout already has a daemon. */
export interface Refusal {
  readonly project: ResolvedProject;
  /** The job already bound to the same mainLocation. */
  readonly blockingKey: string;
}

export interface Plan {
  readonly start: ResolvedProject[];
  readonly restart: ResolvedProject[];
  readonly unchanged: ResolvedProject[];
  /** Supervised jobs absent from config — reported, never stopped (decision 4). */
  readonly removed: string[];
  readonly refused: Refusal[];
}

/**
 * Pure reconciliation: desired config vs supervisor state vs the resolved.json
 * files previous `up` runs wrote. `existing` is keyed by job key and carries
 * both the configHash (restart detection) and mainLocation (collision guard).
 */
export function plan(
  desired: readonly ResolvedProject[],
  actual: readonly JobStatus[],
  existing: ReadonlyMap<string, ResolvedProject>,
): Plan {
  const desiredKeys = new Set(desired.map((project) => project.key));
  const loaded = new Set(actual.filter((job) => job.loaded).map((job) => job.key));
  // mainLocation → owning key: running jobs claim first, then each project we
  // decide to run — so a copy-pasted second project on one checkout is refused
  // even when neither is running yet (the double-dispatch edge decision 12 closes).
  const claims = new Map<string, string>();
  const desiredByKey = new Map(desired.map((project) => [project.key, project]));
  for (const key of loaded) {
    // A loaded job with an unreadable resolved.json must still claim its
    // checkout, or the guard fails open — fall back to its desired config
    // entry so a fresh key on the same mainLocation is refused, not started.
    const location = existing.get(key)?.mainLocation ?? desiredByKey.get(key)?.mainLocation;
    if (location !== undefined && !claims.has(location)) claims.set(location, key);
  }
  const result: Plan = { start: [], restart: [], unchanged: [], removed: [], refused: [] };
  for (const project of desired) {
    const claimedBy = claims.get(project.mainLocation);
    if (claimedBy !== undefined && claimedBy !== project.key) {
      result.refused.push({ project, blockingKey: claimedBy });
      continue;
    }
    claims.set(project.mainLocation, project.key);
    if (!loaded.has(project.key)) result.start.push(project);
    else if (existing.get(project.key)?.configHash === project.configHash) {
      result.unchanged.push(project);
    } else result.restart.push(project);
  }
  for (const job of actual) {
    if (!desiredKeys.has(job.key)) result.removed.push(job.key);
  }
  return result;
}
