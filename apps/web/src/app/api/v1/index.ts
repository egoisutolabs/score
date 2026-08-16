// v1 — the versioned API surface: /api/v1/stream (SSE telemetry),
// /api/v1/fleet (fleet poll), /api/v1/projects/[key]/{actions,logs}
// (lifecycle verbs, log tail). Route modules all export GET/runtime/dynamic,
// so they are re-exported as namespaces to stay unambiguous.
export * as fleet from "./fleet";
export * as projects from "./projects";
export * as stream from "./stream";
