// @score/web — Next.js app: API + console data plane for the web console.
// Owns HTTP routes under src/app/ — /healthz, /readyz, /api/v1/{stream,
// fleet,projects} — wired by Next's file conventions; each route folder
// keeps its own front door. Route modules all export GET/runtime/dynamic,
// so they are re-exported as namespaces to stay unambiguous. Never binds
// beyond loopback.
export * as api from "./app/api";
export * as healthz from "./app/healthz";
export * as readyz from "./app/readyz";
export * as fleet from "./fleet";
export * from "./telemetry";
