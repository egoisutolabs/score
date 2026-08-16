export interface MergedCleanupResult {
  readonly pullRequestNumber: number;
  readonly action: "NOT_FOUND" | "BLOCKED_DIRTY" | "PLANNED" | "CLEANED";
  readonly message?: string;
}

/**
 * Stranded-issue ladder (#64): a worktree whose branch has no PR at all is
 * keyed by issue, not PR — there is no PR number to report.
 */
export interface StrandedCleanupResult {
  readonly issueNumber: number;
  readonly action:
    | "STRANDED_PINGED"
    | "STRANDED_RECLAIMED"
    | "STRANDED_DIRTY"
    | "STRANDED_RESPAWNED";
  readonly dryRun: boolean;
  readonly message?: string;
}

/**
 * Auto-pull refusal (#91): about the primary checkout itself, so it carries
 * neither a PR number nor an issue number — only the loud reason.
 */
export interface AutoPullCleanupResult {
  readonly action: "AUTO_PULL_REFUSED";
  readonly message: string;
}

export type CleanupResult = MergedCleanupResult | StrandedCleanupResult | AutoPullCleanupResult;
