import {
  type HealthInput,
  type HealthState,
  healthFor,
} from "@score/core/observation/health.policy";

export type Dot = "green" | "amber" | "gray" | "red";

export type DotInput = HealthInput;

const DOT_FOR: Record<HealthState, Dot> = {
  healthy: "green",
  stale: "amber",
  crashed: "red",
  stopped: "gray",
};

/** The console's color vocabulary over core's reason-coded health decision. */
export function deriveDot(input: DotInput): Dot {
  return DOT_FOR[healthFor(input).state];
}
