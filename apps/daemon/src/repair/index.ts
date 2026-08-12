/**
 * The manual `score repair` escape hatch: one-shot, Claude/tmux-only, no
 * ledger — it always acts. Renders and runs a single repair pass; never
 * merges, never touches the daemon's pacing.
 */
export * from "./repair.run";
