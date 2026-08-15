/**
 * Cleanup: reclaim worktrees, sessions, and branches of merged work so
 * dispatch capacity frees up first each pass — plus the stranded-issue
 * ladder (#64), which pings and eventually reclaims worktrees whose branch
 * has no PR at all. Refuses to destroy anything dirty or ahead of base.
 */

export * from "./cleanup.policy";
export * from "./cleanup.service";
export * from "./cleanup-result.interface";
