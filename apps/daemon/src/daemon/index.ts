/**
 * Managed daemon composition: bootstrap and preflight, runtime selection,
 * phase wiring, status heartbeat, and fatal unwind. The telemetry/
 * subfeature owns the #78 mapping and the #79 per-pass trace recorder the
 * loop composes around its phases. Composes ports into the tick loop;
 * decides nothing a phase owns.
 */
export * from "./daemon.run";
export * from "./recovery.policy";
export * from "./telemetry";
