// @score/web — API-only Next.js app: the observability data plane. Owns HTTP
// routes under src/app/ — /healthz, /readyz, /api/v1/stream — wired by Next's
// file conventions; each route folder keeps its own front door. Route modules
// all export GET/runtime/dynamic, so they are re-exported as namespaces to
// stay unambiguous. Refuses UI (no pages, no client components) and never
// binds beyond loopback.
export * as api from "./app/api";
export * as healthz from "./app/healthz";
export * as readyz from "./app/readyz";
export * from "./telemetry";
