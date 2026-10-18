export type RepairAction =
  | "NOT_NEEDED"
  | "PINGED"
  | "SPAWNED"
  | "SKIPPED"
  | "WORKING"
  /** A check on the head commit is still running; no ping until it reports. */
  | "CHECKS_PENDING"
  /** The pass could not judge this PR — the review-thread query failed, or a step threw: not known clean, nothing decided. */
  | "UNOBSERVED"
  /** The PR's round budget is spent: labeled, commented once, left to a human. */
  | "EXHAUSTED";

export interface RepairResult {
  readonly pullRequestNumber: number;
  readonly action: RepairAction;
  readonly dryRun: boolean;
  /** The head the pass observed, when GitHub reported one; the ledger's clean clock belongs to one head. */
  readonly headSha?: string;
  readonly target?: string;
  /** UNOBSERVED from a thrown step: what failed, for the operator's log. */
  readonly note?: string;
  /** EXHAUSTED only, and only on the pass that parked the PR: the convergence rule and its numbers. */
  readonly parked?: { readonly rule: string; readonly detail: string };
}
