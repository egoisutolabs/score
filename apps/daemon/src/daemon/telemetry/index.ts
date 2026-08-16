/**
 * Daemon-side telemetry subfeature: the pure phase-result to
 * telemetry-record mapping (#78) and the per-pass trace recorder the tick
 * loop composes around its phases (#79). Owns correlation and failure
 * accounting only — phases stay telemetry-blind, and storage belongs to
 * @score/core's telemetry feature.
 */
export * from "./pass-telemetry.service";
export * from "./telemetry.render";
