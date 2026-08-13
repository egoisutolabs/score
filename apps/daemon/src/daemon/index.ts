/**
 * Managed daemon composition: bootstrap and preflight, runtime selection,
 * phase wiring, status heartbeat, fatal unwind. Composes ports into the
 * tick loop; decides nothing a phase owns.
 */
export * from "./daemon.run";
