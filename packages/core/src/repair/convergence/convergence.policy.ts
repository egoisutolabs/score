import type { FindingRecord } from "@score/core/repair/findings/finding.interface";
import type { WaveRecord } from "@score/core/repair/repair.policy";

/**
 * Review-loop analysis §2.3: the four signals that a repair loop is not
 * converging, all computable from what the ledger already holds. Listed in
 * the order they are checked; the first that fires names the park reason.
 */
export type ConvergenceRule = "budget" | "findings-flat" | "diff-growing" | "regression-from-fix";

export interface ConvergenceVerdict {
  readonly rule: ConvergenceRule;
  readonly detail: string;
}

/** A finding counts unless a classifier judged it probably not real. */
export function countsAsReal(finding: Pick<FindingRecord, "real">): boolean {
  return finding.real === undefined || finding.real >= 0.5;
}

export interface ConvergenceInput {
  /** Waves sent so far, oldest first; each carries the state the agent was sent to fix. */
  readonly waves: readonly WaveRecord[];
  readonly findings: readonly FindingRecord[];
  readonly budget: number;
}

/**
 * Rule 1 needs three waves: "does not decrease for two waves" is two
 * consecutive comparisons. Rule 2 likewise reads three diff sizes. Rule 3
 * fires on a finding the latest fix introduced, so it needs one wave to have
 * been sent and answered; a single such finding parks the PR, as the analysis
 * lists it — the price is a human look at a PR whose first fix drew one nit.
 * Rule 4 is the budget from §2.2.
 */
export function convergenceVerdict(input: ConvergenceInput): ConvergenceVerdict | undefined {
  const { waves, budget } = input;
  if (waves.length >= budget) {
    return { rule: "budget", detail: `${waves.length} wave(s) used the budget of ${budget}` };
  }
  const last = waves.at(-1);
  const prev = waves.at(-2);
  const prev2 = waves.at(-3);
  if (last && prev && prev2) {
    if (last.openFindings >= prev.openFindings && prev.openFindings >= prev2.openFindings) {
      return {
        rule: "findings-flat",
        detail: `open findings ${prev2.openFindings} → ${prev.openFindings} → ${last.openFindings} over the last three waves`,
      };
    }
    if (
      last.diffSize !== undefined &&
      prev.diffSize !== undefined &&
      prev2.diffSize !== undefined &&
      last.diffSize > prev.diffSize &&
      prev.diffSize > prev2.diffSize
    ) {
      return {
        rule: "diff-growing",
        detail: `diff grew ${prev2.diffSize} → ${prev.diffSize} → ${last.diffSize} lines over the last three waves`,
      };
    }
  }
  if (waves.length >= 1) {
    const regressions = input.findings.filter(
      (finding) =>
        finding.fromLastFix &&
        finding.wave === waves.length &&
        finding.resolution !== "reviewer-resolved" &&
        countsAsReal(finding),
    );
    if (regressions.length > 0) {
      const where = regressions
        .map((finding) => `${finding.path}:${finding.symbol ?? "?"}`)
        .join(", ");
      return {
        rule: "regression-from-fix",
        detail: `${regressions.length} finding(s) blame to the last fix commit: ${where}`,
      };
    }
  }
  return undefined;
}
