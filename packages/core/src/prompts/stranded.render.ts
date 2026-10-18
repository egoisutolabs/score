import { promptVersion } from "./prompt-version";

/** Cleanup's stranded ladder (#64): first a ping to a live but PR-less session. */
export function renderStrandedPing(issueNumber: number): string {
  return `score: no PR observed for issue #${issueNumber}. Commit your work and open a PR now, or this workspace will be reclaimed.`;
}

/** Then, once the session is gone, a fresh agent over the preserved dirty worktree. */
export function renderStrandedRespawn(issueNumber: number): string {
  return `score: this workspace for issue #${issueNumber} holds unfinished work and its previous agent session ended. Read TASK.md, review the existing changes, finish the work, and open a PR with Fixes in the body.`;
}

export const STRANDED_PING_VERSION = promptVersion(renderStrandedPing(0));
export const STRANDED_RESPAWN_VERSION = promptVersion(renderStrandedRespawn(0));
