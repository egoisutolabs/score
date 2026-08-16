// console/ — the browser UI over the v1 fleet API: rail, project pane, live
// tail, tick pulse, and the TUI's keyboard vocabulary. Client components
// only; it owns no fleet semantics (src/fleet does) and never imports
// server-side services — its data arrives exclusively over HTTP.
export * from "./console";
export * from "./fleet.hooks";
export * from "./fleet-view.interface";
export * from "./log-pane";
export * from "./project-pane";
export * from "./project-rail";
export * from "./tick-pulse";
