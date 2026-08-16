/**
 * Observation: reason-coded health decisions over supervisor + status-file
 * facts, plus the read-only supervisor job view those decisions consume.
 * Owns decisions and reads only — surfaces (TUI dots, snapshot stream) map
 * {state, reasons} to their own vocabulary; this folder never renders and
 * never exposes a lifecycle verb.
 */
export * from "./health.policy";
export * from "./jobs.service";
