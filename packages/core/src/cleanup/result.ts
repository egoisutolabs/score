export interface CleanupResult {
  readonly pullRequestNumber: number;
  readonly action: "NOT_FOUND" | "BLOCKED_DIRTY" | "PLANNED" | "CLEANED";
  readonly message?: string;
}
