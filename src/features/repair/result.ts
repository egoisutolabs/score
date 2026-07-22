export type RepairAction = "NOT_NEEDED" | "PINGED" | "SPAWNED" | "SKIPPED" | "WORKING";

export interface RepairResult {
  readonly pullRequestNumber: number;
  readonly action: RepairAction;
  readonly dryRun: boolean;
  readonly target?: string;
}
