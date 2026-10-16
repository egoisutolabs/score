export type RepairAction =
  | "NOT_NEEDED"
  | "PINGED"
  | "SPAWNED"
  | "SKIPPED"
  | "WORKING"
  /** A check on the head commit is still running; no ping until it reports. */
  | "CHECKS_PENDING"
  /** The PR's round budget is spent: labeled, commented once, left to a human. */
  | "EXHAUSTED";

export interface RepairResult {
  readonly pullRequestNumber: number;
  readonly action: RepairAction;
  readonly dryRun: boolean;
  readonly target?: string;
  /** EXHAUSTED only, and only on the pass that parked the PR: the convergence rule and its numbers. */
  readonly parked?: { readonly rule: string; readonly detail: string };
}
