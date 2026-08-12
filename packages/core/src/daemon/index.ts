/**
 * Daemon: the tick loop's shared machinery — phase scheduling, status
 * heartbeat, per-pass observation cache, and the repair ledger that stops
 * re-pinging a live agent. Holds no facts of record — pacing state
 * resets on restart by design; durable truth lives in files and GitHub.
 */
export * from "./daemon.service";
export * from "./observations.service";
export * from "./repair-ledger.service";
export * from "./status.service";
