// healthz — liveness only: GET /healthz → 200 while the process serves, zero
// file reads, zero dependencies. Refuses readiness/deep-health semantics (#80).
export * from "./route";
