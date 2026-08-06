import type {
  BuildGate,
  LandingResult,
  PullRequestObservation,
} from "@score/core/landing/change.interface";
import { VERIFY_ARGV } from "@score/core/verify";

const SUCCESSFUL_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export interface LandingCandidatePolicy {
  readonly skipLabels: readonly string[];
  readonly onlyIssueBranches: boolean;
}

export function listLandingCandidates(
  changes: readonly PullRequestObservation[],
  policy: LandingCandidatePolicy,
): readonly PullRequestObservation[] {
  return changes
    .filter((change) => !change.isDraft)
    .filter((change) => !policy.onlyIssueBranches || /^issue-\d+-/.test(change.headRefName))
    .filter((change) => {
      const labels = change.labels.map((label) => label.name.toLowerCase());
      return !labels.some((label) => policy.skipLabels.includes(label));
    })
    .sort((left, right) => left.number - right.number);
}

export function checkRollup(change: PullRequestObservation): {
  readonly failing: number;
  readonly pending: number;
} {
  let failing = 0;
  let pending = 0;
  for (const check of change.statusCheckRollup) {
    if ("status" in check) {
      if (check.status !== "COMPLETED") pending += 1;
      else if (!SUCCESSFUL_CONCLUSIONS.has(check.conclusion ?? "")) failing += 1;
    } else if (check.state === "PENDING" || check.state === "EXPECTED") pending += 1;
    else if (check.state !== "SUCCESS") failing += 1;
  }
  return { failing, pending };
}

/** Cheap GitHub preconditions are only the first stage of landing, never readiness itself. */
export function evaluatePreconditions(
  change: PullRequestObservation,
  unresolvedThreads: number,
): LandingResult | null {
  if (change.mergeable === "CONFLICTING") {
    return {
      pullRequestNumber: change.number,
      tag: "conflict",
      note: "needs main pulled / manual conflict resolution",
    };
  }
  if (change.reviewDecision === "CHANGES_REQUESTED") {
    return {
      pullRequestNumber: change.number,
      tag: "changes-requested",
      note: "a reviewer is requesting changes",
    };
  }
  const checks = checkRollup(change);
  if (checks.failing > 0) {
    return {
      pullRequestNumber: change.number,
      tag: "checks-red",
      note: `${checks.failing} failing GitHub check(s)`,
    };
  }
  if (checks.pending > 0) {
    return {
      pullRequestNumber: change.number,
      tag: "checks-pending",
      note: `${checks.pending} GitHub check(s) still running`,
    };
  }
  if (unresolvedThreads > 0) {
    return {
      pullRequestNumber: change.number,
      tag: "unresolved",
      note: `${unresolvedThreads} unresolved review thread(s)`,
    };
  }
  return null;
}

/**
 * One project-agnostic merged-tree gate: `make verify` at the repository root
 * (the Score contract — see verify.ts). The legacy touched-area classifier
 * (daemon/dashboard directories) described a repo layout no current target
 * has, so every PR since the port merged with zero local gates. Fail-safe on
 * purpose: the gate runs regardless of which files changed — an empty file
 * list (API hiccup) must never read as green, and a repo without the Makefile
 * target fails the gate instead of merging unverified.
 */
/** Set generously above the worst observed pass, like the supervisor kill timeout. */
export const VERIFY_TIMEOUT_MS = 30 * 60_000;

export function gatesFor(repositoryRoot: string): readonly BuildGate[] {
  return [
    {
      name: "verify",
      cwd: repositoryRoot,
      steps: [
        {
          label: "verify",
          command: [...VERIFY_ARGV],
          retry: true,
          timeoutMs: VERIFY_TIMEOUT_MS,
        },
      ],
    },
  ];
}
