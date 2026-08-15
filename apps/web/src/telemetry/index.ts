/**
 * Telemetry stream shaping for @score/web: the v1 SSE envelope, stream
 * sequence IDs, safe error rendering, and the readiness probe /readyz serves.
 * Owns wire shaping and probes only — the record/segment vocabulary and all
 * segment reading stay in @score/core telemetry, and nothing here mutates
 * the store or derives identity. The stream itself (#56) composes these;
 * route files stay thin parsers.
 */
export * from "./envelope.interface";
export * from "./envelope.render";
export * from "./readiness";
export * from "./stream-id.render";
