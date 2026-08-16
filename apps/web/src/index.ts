// @score/web — API-only Next.js app: the observability data plane. Owns HTTP
// routes under src/app/ — /healthz, /readyz, /api/v1/stream — wired by Next's
// file conventions; each route folder keeps its own front door. Route modules
// all export GET/runtime/dynamic, so star-exporting more than one here is a
// TS2308 ambiguity — the roster above is their table of contents. Refuses UI
// (no pages, no client components) and never binds beyond loopback.
export * from "./app/healthz";
export * from "./telemetry";
