/**
 * Cleanup: reclaim worktrees, sessions, and branches of merged work so
 * dispatch capacity frees up first each pass. Acts only on merged evidence.
 */

export * from "./cleanup.policy";
export * from "./cleanup.service";
export * from "./cleanup-result.interface";
