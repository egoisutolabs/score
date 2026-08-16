// console/ — the browser UI over the v1 fleet API and the telemetry stream,
// in the Score Web design file's system: chrome (tabs, wordmark, banners),
// the Fleet view (rail, tiles, merge chart, activity feed + journal,
// open-PRs-by-trouble), History (merge history from replayed decisions),
// Config (read-only resolved fleet), and the TUI's keyboard vocabulary.
// Client components only; it owns no fleet semantics (src/fleet does) and
// never imports server-side services — data arrives exclusively over HTTP.

export * from "./activity.hooks";
export * from "./activity.policy";
export * from "./activity-pane";
export * from "./alert-banner";
export * from "./config-page";
export * from "./console";
export * from "./fleet.hooks";
export * from "./fleet-view.interface";
export * from "./format";
export * from "./history-page";
export * from "./log-pane";
export * from "./merge-chart";
export * from "./pr-panel";
export * from "./project-rail";
export * from "./stat-tiles";
export * from "./tone";
