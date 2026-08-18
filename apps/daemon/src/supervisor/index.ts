/**
 * score up / down / restart / doctor: validate config, write resolved.json,
 * and reconcile project daemons plus the fleet's read-only API service under
 * launchd/systemd. Manages supervisors and files only; never runs a phase.
 */
export * from "./doctor";
export * from "./supervisor.run";
