/**
 * Dispatch: observe eligible issues, create worktrees and TASK.md briefings,
 * start implementation sessions. Owns all work identity naming (sessions,
 * branches). Authority: starts work; never merges, never edits landed code.
 */

export * from "./dispatch.identity";
export * from "./dispatch.policy";
export * from "./dispatch.service";
export * from "./dispatch-result.interface";
export * from "./issue.interface";
export * from "./task-briefing.interface";
export * from "./task-briefing.service";
export * from "./work.interface";
export * from "./work-source.interface";
