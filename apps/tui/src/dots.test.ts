import type { HealthState } from "@score/core/observation/health.policy";
import { type Dot, dotForHealth } from "@score/tui/dots";
import { describe, expect, it } from "vitest";

describe("dotForHealth", () => {
  const table: [HealthState, Dot][] = [
    ["healthy", "green"],
    ["stale", "amber"],
    ["crashed", "red"],
    ["stopped", "gray"],
  ];

  for (const [state, expected] of table) {
    it(`${state} -> ${expected}`, () => {
      expect(dotForHealth(state)).toBe(expected);
    });
  }
});
