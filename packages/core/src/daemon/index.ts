/**
 * Daemon: the tick loop's shared machinery — phase scheduling, status
 * heartbeat, per-pass observation cache, and the repair ledger that paces
 * pings, spends each PR's round budget, and keys its findings. The ledger is
 * the one piece of daemon state that outlives the process: the store
 * persists it per managed project, so a restart keeps budgets, wave history,
 * and findings while the liveness tick is clamped to the new process. Facts
 * about code and PRs still live in files and GitHub, never here.
 */
export * from "./daemon.service";
export * from "./observations.service";
export * from "./repair-ledger.service";
export * from "./repair-ledger.store";
export * from "./status.service";
