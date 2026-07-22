import type {
  PullRequestIdentity,
  PullRequestObservation,
  RepairPullRequestObservation,
} from "@/features/landing/change";

export interface ChangeHost {
  observeOpenChanges(): Promise<readonly PullRequestObservation[]>;
  observeOpenChangeHeads(): Promise<readonly PullRequestIdentity[]>;
  observeRepairChanges(): Promise<readonly RepairPullRequestObservation[]>;
  observeMergedOwnedChanges(): Promise<readonly PullRequestIdentity[]>;
  unresolvedThreadCount(pullRequestNumber: number): Promise<number>;
}
