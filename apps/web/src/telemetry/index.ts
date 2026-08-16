// telemetry — the web app's observability feature: the readiness probe and
// the v1 stream envelope (reason enums, SSE frame shaping). Refuses replay,
// cursors, filters, and follow (#81/#82) and never mutates any store.
export * from "./readiness.service";
export * from "./stream-envelope.interface";
export * from "./stream-envelope.render";
