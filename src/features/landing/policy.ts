import { join } from "node:path";

import type { BuildGate, LandingResult, PullRequestObservation } from "@/features/landing/change";

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

/** Touched-area gates are intentionally identical to babysit-prs.mjs. */
export function gatesFor(
  change: PullRequestObservation,
  repositoryRoot: string,
): readonly BuildGate[] {
  const directories = new Set(change.files.map((file) => file.path.split("/")[0]));
  const gates: BuildGate[] = [];
  if (directories.has("daemon")) {
    gates.push({
      name: "daemon",
      cwd: join(repositoryRoot, "daemon"),
      steps: [
        { label: "check", command: ["bun", "run", "check"] },
        { label: "test", command: ["bun", "test"], retry: true },
      ],
    });
  }
  if (directories.has("dashboard")) {
    gates.push({
      name: "dashboard",
      cwd: join(repositoryRoot, "dashboard"),
      steps: [
        { label: "lint", command: ["bun", "run", "lint"] },
        { label: "build", command: ["bun", "run", "build"] },
      ],
    });
  }
  return gates;
}
