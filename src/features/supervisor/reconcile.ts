import type { ResolvedProject } from "@/features/config/model";
import type { JobStatus } from "@/features/supervisor/adapter";

/** Decision 12: a project refused because its checkout already has a daemon. */
export interface Refusal {
  readonly project: ResolvedProject;
  /** The job already bound to the same mainLocation. */
  readonly blockingKey: string;
  /** The blocker's checkout is unknowable (unreadable state), so we fail closed. */
  readonly unknownState?: true;
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
 * `canonicalize` resolves symlink spellings so two configs naming one checkout
 * differently still collide.
 */
export function plan(
  desired: readonly ResolvedProject[],
  actual: readonly JobStatus[],
  existing: ReadonlyMap<string, ResolvedProject>,
  canonicalize: (path: string) => string = (path) => path,
): Plan {
  const desiredKeys = new Set(desired.map((project) => project.key));
  const desiredByKey = new Map(desired.map((project) => [project.key, project]));
  const loaded = new Set(actual.filter((job) => job.loaded).map((job) => job.key));
  // canonical mainLocation → owning key: running jobs claim first, then each
  // project we decide to run — so a copy-pasted second project on one checkout
  // is refused even when neither is running yet (the double-dispatch edge
  // decision 12 closes). A loaded job with an unreadable resolved.json falls
  // back to its desired config entry; when even that is missing its checkout
  // is unknowable, and every new start is refused until it is downed (fail
  // closed — it could be sitting on any of those checkouts).
  const claims = new Map<string, string>();
  const unknown: string[] = [];
  for (const key of loaded) {
    const location = existing.get(key)?.mainLocation ?? desiredByKey.get(key)?.mainLocation;
    if (location === undefined) {
      unknown.push(key);
      continue;
    }
    const canonical = canonicalize(location);
    if (!claims.has(canonical)) claims.set(canonical, key);
  }
  const result: Plan = { start: [], restart: [], unchanged: [], removed: [], refused: [] };
  for (const project of desired) {
    const canonical = canonicalize(project.mainLocation);
    const claimedBy = claims.get(canonical);
    if (claimedBy !== undefined && claimedBy !== project.key) {
      result.refused.push({ project, blockingKey: claimedBy });
      continue;
    }
    if (!loaded.has(project.key) && unknown[0] !== undefined) {
      result.refused.push({ project, blockingKey: unknown[0], unknownState: true });
      continue;
    }
    claims.set(canonical, project.key);
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
