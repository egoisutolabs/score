/**
 * Managed daemon composition: bootstrap and preflight, runtime selection,
 * phase wiring, status heartbeat, fatal unwind, and the pure phase-result
 * to telemetry-record mapping (#78) wired into the tick loop as one
 * correlated trace per pass (#79). Composes ports into the tick loop;
 * decides nothing a phase owns.
 */
export * from "./daemon.run";
export * from "./recovery.policy";
export * from "./telemetry.render";
