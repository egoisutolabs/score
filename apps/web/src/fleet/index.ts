// fleet — the web console's fleet-viewing and lifecycle feature, ported from
// the TUI: per-project health snapshots (config ∪ supervisor jobs), the dot
// color vocabulary, start/stop/restart over the SupervisorAdapter, and the
// routes' composition seam plus fleet's own v1 envelope vocabulary. Owns the
// process-wide adapter wiring; refuses rendering (the console pages' scope)
// and log reading (the telemetry stream's scope).
export * from "./actions.service";
export * from "./dot.policy";
export * from "./envelope.render";
export * from "./fleet.service";
export * from "./project-view.render";
export * from "./snapshot.service";
