import type { WorkIdentity, WorktreeObservation } from "@/features/dispatch/work";

export interface PrimaryCheckoutObservation {
  readonly branch: string;
  readonly status: string;
}

export interface WorkspaceDriver {
  observeWorktrees(): Promise<readonly WorktreeObservation[]>;
  createWorktree(identity: WorkIdentity): Promise<void>;
  status(worktreePath: string): Promise<string>;
  removeWorktree(worktree: WorktreeObservation): Promise<void>;
  deleteBranch(branch: string): Promise<boolean>;
  observePrimaryCheckout(): Promise<PrimaryCheckoutObservation>;
  fetchOrigin(): Promise<void>;
  stageMerge(remoteBranch: string): Promise<boolean>;
  abortMerge(): Promise<void>;
  commitMerge(message: string): Promise<void>;
  pushDefaultBranch(defaultBranch: string): Promise<void>;
  fastForwardDefaultBranch(defaultBranch: string): Promise<boolean>;
}
