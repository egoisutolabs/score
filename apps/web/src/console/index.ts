// console/ — the browser UI over the v1 fleet API and the telemetry stream:
// rail, banners, stat tiles, merge chart, activity feed (events + journal),
// open-PRs-by-trouble panel, tick pulse, and the TUI's keyboard vocabulary.
// Client components only; it owns no fleet semantics (src/fleet does) and
// never imports server-side services — data arrives exclusively over HTTP.

export * from "./activity.hooks";
export * from "./activity.policy";
export * from "./activity-pane";
export * from "./alert-banner";
export * from "./console";
export * from "./fleet.hooks";
export * from "./fleet-view.interface";
export * from "./format";
export * from "./log-pane";
export * from "./merge-chart";
export * from "./pr-panel";
export * from "./project-rail";
export * from "./stat-tiles";
export * from "./tick-pulse";
export * from "./tone";
