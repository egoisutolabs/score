/**
 * Managed daemon composition: bootstrap and preflight, runtime selection,
 * phase wiring, status heartbeat, fatal unwind. Composes ports into the
 * tick loop; decides nothing a phase owns. Tick telemetry lives behind its
 * own front door in ./telemetry/.
 */
export * from "./daemon.run";
export * from "./recovery.policy";
