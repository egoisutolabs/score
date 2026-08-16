// @score/web — API-only Next.js app: the observability data plane. Owns HTTP
// routes under src/app/; refuses UI (no pages, no client components) and never
// binds beyond loopback. Routes are wired by Next's file conventions — this
// front door exists for comprehension, not import ceremony.
export * from "./app/healthz";
