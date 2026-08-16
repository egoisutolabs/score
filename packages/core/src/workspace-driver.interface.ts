import type { WorkIdentity, WorktreeObservation } from "@score/core/dispatch/work.interface";

export interface PrimaryCheckoutObservation {
  readonly branch: string;
  readonly status: string;
}

/**
 * Worktree capability: observe/create/inspect/remove issue worktrees.
 * Dispatch and cleanup hold this port; it carries no merge or push
 * authority, so "dispatch never pushes" is compiler-enforced (#19).
 */
export interface WorktreeProvisioner {
  observeWorktrees(): Promise<readonly WorktreeObservation[]>;
  createWorktree(identity: WorkIdentity): Promise<void>;
  status(worktreePath: string): Promise<string>;
  /**
   * True when `ancestor` is an ancestor of (or equal to) `descendant`.
   * Read-only evidence for cleanup's stranded ladder (#64): a head that is
   * an ancestor of base proves the branch holds no commits of its own.
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  removeWorktree(worktree: WorktreeObservation): Promise<void>;
  deleteBranch(branch: string): Promise<boolean>;
}

/**
 * Merge/push capability over the primary checkout. Landing holds the full
 * port; other phases may hold only narrowed slices (Pick) of it — repair
 * gets observation only, so "repair never merges" is compiler-enforced (#19).
 */
export interface LandingWorkspace {
  fetchOrigin(): Promise<void>;
  observePrimaryCheckout(): Promise<PrimaryCheckoutObservation>;
  /** Stage a merge of the exact observed commit — callers pass a SHA, not a mutable ref. */
  stageMerge(commit: string): Promise<boolean>;
  abortMerge(): Promise<void>;
  /**
   * Finish a residue sweep an earlier abort left behind (#92) — idempotent,
   * no-op without persisted evidence. Landing runs it each tick before the
   * checkout-readiness check, or the very dirt it would remove blocks it.
   */
  sweepStageResidue(): Promise<readonly string[]>;
  commitMerge(message: string): Promise<void>;
  pushDefaultBranch(defaultBranch: string): Promise<void>;
  fastForwardDefaultBranch(defaultBranch: string): Promise<boolean>;
}
