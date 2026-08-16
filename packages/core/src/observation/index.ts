/**
 * Observation: reason-coded health decisions over supervisor + status-file
 * facts. Owns the decision only — surfaces (TUI dots, snapshot stream) map
 * {state, reasons} to their own vocabulary; this folder never renders.
 */
export * from "./health.policy";
