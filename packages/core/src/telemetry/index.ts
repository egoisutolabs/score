/**
 * Telemetry: the versioned record vocabulary and the per-project dated JSONL
 * log — one daemon appends, any reader tails without coordination. Never a
 * source of current truth for any phase, never an identity authority
 * (subjects copy dispatch.identity.ts values verbatim), and never mutated:
 * segments are append-only and retention deletes whole dated files.
 */

export * from "./telemetry.interface";
export * from "./telemetry.policy";
export * from "./telemetry-log.service";
