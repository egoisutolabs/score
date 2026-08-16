// [key] — one project's routes: actions (lifecycle verbs over the
// supervisor). Logs deliberately have no route here — the journal travels
// through /api/v1/stream's log signal, the telemetry feature's one pipe.
export * as actions from "./actions";
