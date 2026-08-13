/**
 * Repair: scan open PRs for defects (conflicts, red checks, unresolved
 * threads) and ping or spawn repair agents. Never merges; pacing is the
 * daemon ledger's job, not policy here.
 */

export * from "./repair.policy";
export * from "./repair.service";
export * from "./repair-result.interface";
