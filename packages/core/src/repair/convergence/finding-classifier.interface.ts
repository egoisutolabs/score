import type { FindingRecord } from "@score/core/repair/findings/finding.interface";

/**
 * The typed questions a model-backed classifier (jev or another) may answer
 * about a finding, each as one probability. The convergence rules count a
 * finding unless a classifier says it is probably not real; nothing else
 * reads these numbers yet. The default classifier answers nothing, so the
 * gate stays deterministic until an implementation is configured.
 */
export interface FindingAssessment {
  /** Probability the finding describes a real defect. */
  readonly real: number;
}

export interface FindingClassifier {
  assess(finding: FindingRecord): Promise<FindingAssessment | undefined>;
}

/** Deterministic default: no opinion, every finding counts. */
export const NO_CLASSIFIER: FindingClassifier = {
  async assess() {
    return undefined;
  },
};
