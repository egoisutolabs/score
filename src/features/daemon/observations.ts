import type {
  PullRequestIdentity,
  PullRequestObservation,
  RepairPullRequestObservation,
} from "@/features/landing/change";
import type { ChangeHost } from "@/features/landing/port";

/**
 * Dispatch asks "is this issue already in flight?" once per candidate, and every
 * candidate that has no worktree and no session pays for a `gh pr list`. One
 * snapshot per pass answers all of them.
 *
 * Only the identity list is cached. Landing's and repair's observations stay
 * live because landing merges PRs in the middle of a pass — repair must not act
 * on a list drawn before that.
 */
export class PassCachedChangeHost implements ChangeHost {
  #openHeads: Promise<readonly PullRequestIdentity[]> | undefined;

  constructor(private readonly inner: ChangeHost) {}

  /** Call at the top of each pass; a failed lookup is retried on the next one. */
  startPass(): void {
    this.#openHeads = undefined;
  }

  observeOpenChangeHeads(): Promise<readonly PullRequestIdentity[]> {
    this.#openHeads ??= this.inner.observeOpenChangeHeads();
    return this.#openHeads;
  }

  observeOpenChanges(): Promise<readonly PullRequestObservation[]> {
    return this.inner.observeOpenChanges();
  }

  observeRepairChanges(): Promise<readonly RepairPullRequestObservation[]> {
    return this.inner.observeRepairChanges();
  }

  observeMergedOwnedChanges(): Promise<readonly PullRequestIdentity[]> {
    return this.inner.observeMergedOwnedChanges();
  }

  unresolvedThreadCount(pullRequestNumber: number): Promise<number> {
    return this.inner.unresolvedThreadCount(pullRequestNumber);
  }
}
