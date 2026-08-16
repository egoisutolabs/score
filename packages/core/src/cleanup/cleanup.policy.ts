import type { PrimaryCheckoutObservation } from "@score/core/workspace-driver.interface";

/** Legacy reads each porcelain record's path text without interpreting renames. */
export function changedPathsFromPorcelain(status: string): readonly string[] {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
}

export function cleanupStatusIsSafe(status: string, allowlist: readonly string[]): boolean {
  return changedPathsFromPorcelain(status).every((path) =>
    allowlist.some((owned) => (owned.endsWith("/") ? path.startsWith(owned) : path === owned)),
  );
}

/**
 * Auto-pull refusal (#91): fastForwardDefaultBranch refuses without saying
 * why, and the silence once left the fleet 30 commits stale for four hours.
 * The caller re-observes the primary and this names the blockers.
 */
export function autoPullRefusalReason(
  checkout: PrimaryCheckoutObservation,
  defaultBranch: string,
): string {
  if (checkout.branch !== defaultBranch) {
    return `primary checkout is on ${checkout.branch}, not ${defaultBranch}`;
  }
  const paths = changedPathsFromPorcelain(checkout.status);
  if (paths.length > 0) {
    // Untracked build caches can dirty hundreds of files; name enough to act
    // on without flooding the log.
    const shown = paths.slice(0, 10);
    const more = paths.length - shown.length;
    return `primary checkout is not clean: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
  }
  // The dirt was gone by this re-observation (a racing operator action) —
  // still loud, just without paths to name.
  return "fast-forward refused despite a clean primary checkout";
}

export interface StrandedEntry {
  /** Tick when the current headSha was first observed with no PR for the branch. */
  readonly sinceTick: number;
  readonly headSha: string | undefined;
  readonly pingedAtTick?: number;
}

export type StrandedDecision = "WAIT" | "PING" | "RECLAIM";

/**
 * Stranded ladder (#64), mirroring repair's ping-then-escalate: a live agent
 * gets one silent window, a ping, and a full second window to commit or open
 * a PR; a missing session skips straight to reclaim — there is nobody left
 * to ping.
 */
export function decideStranded(
  entry: StrandedEntry,
  tick: number,
  sessionAlive: boolean,
  staleTicks: number,
): StrandedDecision {
  if (!sessionAlive) return "RECLAIM";
  if (entry.pingedAtTick !== undefined) {
    return tick - entry.pingedAtTick >= staleTicks ? "RECLAIM" : "WAIT";
  }
  return tick - entry.sinceTick >= staleTicks ? "PING" : "WAIT";
}

export function strandedPingMessage(issueNumber: number): string {
  return `score: no PR observed for issue #${issueNumber}. Commit your work and open a PR now, or this workspace will be reclaimed.`;
}

export function strandedRespawnPrompt(issueNumber: number): string {
  return `score: this workspace for issue #${issueNumber} holds unfinished work and its previous agent session ended. Read TASK.md, review the existing changes, finish the work, and open a PR with Fixes in the body.`;
}
