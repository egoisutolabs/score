/**
 * Supervisor: install and reconcile managed daemons under launchd (macOS)
 * or systemd user units (Linux). Owns job definitions, not daemon behavior.
 */
export * from "./launchd.service";
export * from "./plist.render";
export * from "./reconcile.policy";
export * from "./supervisor-adapter.interface";
export * from "./systemd.service";
