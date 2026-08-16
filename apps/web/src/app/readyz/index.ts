// readyz — readiness only: GET /readyz → 200 when every project's resolved
// config parses and today's telemetry segments are readable; absence is
// ready. Refuses deep health, supervisor, and GitHub semantics.
export * from "./route";
