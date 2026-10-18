import type { FindingRecord } from "@score/core/repair/findings/finding.interface";
import type { WaveRecord } from "@score/core/repair/repair.policy";
import { expect, test } from "vitest";
import { convergenceVerdict, countsAsReal } from "./convergence.policy";

const DEFECTS = { conflicting: false, unresolvedThreads: 1, failingChecks: 0 };

function wave(openFindings: number, diffSize?: number): WaveRecord {
  return {
    at: "T",
    tick: 0,
    headSha: "h",
    defects: DEFECTS,
    openFindings,
    diffSize,
    promptVersion: "v",
  };
}

function finding(overrides: Partial<FindingRecord>): FindingRecord {
  return {
    threadId: "T",
    key: "k",
    path: "a.ts",
    symbol: "f",
    origin: "o",
    author: "codex",
    createdAt: "",
    class: "regression-from-fix",
    wave: 2,
    fromLastFix: true,
    resolution: "open",
    resolvedBy: undefined,
    ...overrides,
  };
}

test("no rule fires on a loop that is still converging", () => {
  // Findings falling, diff shrinking, nothing blamed to the last fix.
  expect(
    convergenceVerdict({
      waves: [wave(5, 300), wave(3, 280), wave(1, 250)],
      findings: [],
      budget: 8,
    }),
  ).toBeUndefined();
  // Too early for the three-wave rules; no wave sent yet means no "last fix" either.
  expect(
    convergenceVerdict({ waves: [wave(5, 300), wave(4, 290)], findings: [], budget: 8 }),
  ).toBeUndefined();
  expect(
    convergenceVerdict({ waves: [], findings: [finding({ wave: 0 })], budget: 8 }),
  ).toBeUndefined();
});

test("rule 4: the budget fires first and exactly at the budget", () => {
  expect(
    convergenceVerdict({ waves: [wave(1), wave(1)], findings: [], budget: 3 }),
  ).toBeUndefined();
  expect(
    convergenceVerdict({ waves: [wave(1), wave(1), wave(1)], findings: [], budget: 3 }),
  ).toMatchObject({
    rule: "budget",
  });
});

test("rule 1: findings that do not decrease for two waves", () => {
  expect(
    convergenceVerdict({ waves: [wave(3), wave(3), wave(4)], findings: [], budget: 8 }),
  ).toMatchObject({
    rule: "findings-flat",
    detail: "open findings 3 → 3 → 4 over the last three waves",
  });
  // One decrease inside the window is still convergence.
  expect(
    convergenceVerdict({ waves: [wave(3), wave(2), wave(2)], findings: [], budget: 8 }),
  ).toBeUndefined();
  // Three waves for conflicts or red checks alone: no findings, nothing flat.
  expect(
    convergenceVerdict({ waves: [wave(0), wave(0), wave(0)], findings: [], budget: 8 }),
  ).toBeUndefined();
});

test("rule 2: the diff grows with each of the last three waves", () => {
  expect(
    convergenceVerdict({
      waves: [wave(4, 100), wave(3, 150), wave(2, 170)],
      findings: [],
      budget: 8,
    }),
  ).toMatchObject({
    rule: "diff-growing",
    detail: "diff grew 100 → 150 → 170 lines over the last three waves",
  });
  // Flat diff, or a wave whose size GitHub did not report, does not fire.
  expect(
    convergenceVerdict({
      waves: [wave(4, 100), wave(3, 100), wave(2, 170)],
      findings: [],
      budget: 8,
    }),
  ).toBeUndefined();
  expect(
    convergenceVerdict({
      waves: [wave(4, 100), wave(3, undefined), wave(2, 170)],
      findings: [],
      budget: 8,
    }),
  ).toBeUndefined();
});

test("rule 3: a finding the last fix introduced, open or self-resolved, counts unless a classifier doubts it", () => {
  const waves = [wave(3, 100), wave(2, 90)];
  // One wave answered is enough: the first fix can already regress.
  expect(
    convergenceVerdict({ waves: [wave(3, 100)], findings: [finding({ wave: 1 })], budget: 8 }),
  ).toMatchObject({ rule: "regression-from-fix" });
  // One wave answered is enough: the first fix can already regress.
  expect(
    convergenceVerdict({ waves: [wave(3, 100)], findings: [finding({ wave: 1 })], budget: 8 }),
  ).toMatchObject({
    rule: "regression-from-fix",
  });
  expect(convergenceVerdict({ waves, findings: [finding({})], budget: 8 })).toMatchObject({
    rule: "regression-from-fix",
    detail: "1 finding(s) blame to the last fix commit: a.ts:f",
  });
  expect(
    convergenceVerdict({ waves, findings: [finding({ resolution: "self-resolved" })], budget: 8 }),
  ).toMatchObject({ rule: "regression-from-fix" });
  // A reviewer closed it, it predates the last wave, or it is not from the fix: no fire.
  expect(
    convergenceVerdict({
      waves,
      findings: [finding({ resolution: "reviewer-resolved" })],
      budget: 8,
    }),
  ).toBeUndefined();
  expect(
    convergenceVerdict({ waves, findings: [finding({ wave: 1 })], budget: 8 }),
  ).toBeUndefined();
  expect(
    convergenceVerdict({ waves, findings: [finding({ fromLastFix: false })], budget: 8 }),
  ).toBeUndefined();
  // A classifier judging it probably not real removes it from the count.
  expect(
    convergenceVerdict({ waves, findings: [finding({ real: 0.2 })], budget: 8 }),
  ).toBeUndefined();
  expect(
    convergenceVerdict({ waves, findings: [finding({ real: 0.5 })], budget: 8 }),
  ).toMatchObject({
    rule: "regression-from-fix",
  });
});

test("countsAsReal: no opinion counts, and the classifier threshold is one half", () => {
  expect(countsAsReal({ real: undefined })).toBe(true);
  expect(countsAsReal({ real: 0.49 })).toBe(false);
  expect(countsAsReal({ real: 0.5 })).toBe(true);
});
