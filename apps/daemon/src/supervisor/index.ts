/**
 * score up / down / restart / doctor: validate config, write resolved.json,
 * and install or reconcile launchd/systemd jobs. Manages supervisors and
 * files only; never runs a phase itself.
 */
export * from "./doctor";
export * from "./supervisor.run";
