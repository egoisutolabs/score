import type { ReviewThreadObservation } from "@score/core/repair/findings/finding.interface";

/**
 * What repair asks GitHub beyond ChangeHost: the review threads it keys, and
 * the few mutations it performs itself when a PR's round budget runs out.
 * Kept apart from ChangeHost (observation only) so the pass-cached wrapper
 * and the landing fakes never grow methods they must not call.
 */
export interface RepairHost {
  /** Every review thread on the PR, all pages; throws rather than returning a partial list. */
  observeReviewThreads(pullRequestNumber: number): Promise<readonly ReviewThreadObservation[]>;
  /** Adds the label, creating it in the repository if missing. Re-adding is a no-op. */
  addLabel(pullRequestNumber: number, label: string): Promise<void>;
  /** Whether any comment on the PR's conversation contains `marker` verbatim. */
  hasComment(pullRequestNumber: number, marker: string): Promise<boolean>;
  comment(pullRequestNumber: number, body: string): Promise<void>;
}
