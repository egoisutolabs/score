import type {
  PullRequestIdentity,
  PullRequestObservation,
  RepairPullRequestObservation,
} from "@score/core/landing/change.interface";

export interface ChangeHost {
  observeOpenChanges(): Promise<readonly PullRequestObservation[]>;
  observeOpenChangeHeads(): Promise<readonly PullRequestIdentity[]>;
  observeRepairChanges(): Promise<readonly RepairPullRequestObservation[]>;
  observeMergedOwnedChanges(): Promise<readonly PullRequestIdentity[]>;
  /**
   * Closed-but-unmerged owned PRs. A closed PR is an operator's abandonment
   * verdict on its branch: cleanup's stranded ladder (#64) must not read
   * that branch as PR-less work to revive or reclaim.
   */
  observeClosedOwnedChanges(): Promise<readonly PullRequestIdentity[]>;
  unresolvedThreadCount(pullRequestNumber: number): Promise<number>;
}
