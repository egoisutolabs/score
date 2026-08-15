/**
 * The HTTP surface of @score/web: Next.js App Router route handlers — in
 * this epic the probes only; the v1 SSE stream route (#56) joins them here.
 * Owns routing and status codes; behavior lives in src/telemetry and route
 * files stay thin parsers. Refuses pages, client components, and any
 * mutation of Score state.
 */
export * as healthz from "./healthz";
export * as readyz from "./readyz";
