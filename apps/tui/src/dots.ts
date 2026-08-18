import type { HealthState } from "@score/core/observation/health.policy";

export type Dot = "green" | "amber" | "gray" | "red";

const DOT_FOR: Record<HealthState, Dot> = {
  healthy: "green",
  stale: "amber",
  crashed: "red",
  stopped: "gray",
};

/** The TUI's color vocabulary over the server's reason-coded health state. */
export function dotForHealth(state: HealthState): Dot {
  return DOT_FOR[state];
}
