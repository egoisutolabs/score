/**
 * Repair: scan open PRs for defects (conflicts, red checks, unresolved
 * threads) and ping or spawn repair agents, one wave per review round, up to
 * a per-PR round budget. Never merges; pacing is the daemon ledger's job, not
 * policy here.
 */

export * from "./convergence/index";
export * from "./findings/index";
export * from "./repair.policy";
export * from "./repair.service";
export * from "./repair-host.interface";
export * from "./repair-result.interface";
