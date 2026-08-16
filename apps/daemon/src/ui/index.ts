/**
 * score ui: serve the web console (apps/web) from this checkout — build on
 * first run, then `next start` bound to 127.0.0.1. A viewer only: it never
 * touches daemons or supervisors, and quitting it never touches the fleet.
 */
export * from "./ui.run";
