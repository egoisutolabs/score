export interface WorkIdentity {
  readonly issueNumber: number;
  readonly branch: string;
  readonly worktreePath: string;
  readonly sessionName: string;
}

export interface WorktreeObservation {
  readonly path: string;
  readonly branch: string;
  readonly headSha?: string;
  readonly locked: boolean;
}

export interface WorkWitnesses {
  readonly worktree: boolean;
  readonly session: boolean;
  readonly openPullRequest: boolean;
}
