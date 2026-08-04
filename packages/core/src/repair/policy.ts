import { VERIFY_COMMAND } from "@score/core/verify";

/**
 * Must match the session names dispatch creates (`issue-N` in identity.ts).
 * Legacy defaulted to "-issue-%N", which never matched its own "issue-N"
 * sessions, so repair silently always spawned instead of pinging. Anchored so
 * an unrelated session like "my-issue-1" can't be pinged by mistake.
 */
export const DEFAULT_SESSION_SUFFIX = "^issue-%N";

/**
 * A managed daemon matches exactly the sessions its own dispatch creates
 * (`score-<key>-issue-N`, see sessionNameForIssue) — a bare or foreign-project
 * session must never be pinged. Identity's naming and this template are tied
 * together by a test.
 */
export function sessionSuffixForNamespace(namespace: string | undefined): string {
  return namespace === undefined ? DEFAULT_SESSION_SUFFIX : `^score-${namespace}-issue-%N`;
}

export interface RepairDefects {
  readonly conflicting: boolean;
  readonly unresolvedThreads: number;
  readonly failingChecks: number;
  /**
   * Landing's build-red gate-failure tail (epic decision 11): the PR merges
   * textually but fails the merged-tree gate — invisible to GitHub CI, so
   * repair's own scan can never see it. Undefined = no verdict.
   */
  readonly buildRed?: string;
}

export function needsRepair(defects: RepairDefects): boolean {
  return (
    defects.conflicting ||
    defects.unresolvedThreads > 0 ||
    defects.failingChecks > 0 ||
    defects.buildRed !== undefined
  );
}

/** Repair prompt names every defect class while explicitly withholding merge authority. */
export function renderRepairPrompt(pullRequestNumber: number, buildRed?: string): string {
  const gateNote =
    buildRed === undefined
      ? ""
      : ` Note: this PR also fails the local merged-tree build gate, which GitHub CI cannot see — after merging origin/main, fix this failure too: ${buildRed}.`;
  return `Follow-up on your PR #${pullRequestNumber}: it needs cleanup before it can land. Please do all of: (1) git fetch origin && merge origin/main into this branch, resolving every conflict correctly per the code's intent; (2) address any unresolved review threads — list them with gh api graphql reviewThreads where isResolved is false, fix each in code, then resolve via resolveReviewThread; (3) check failing CI with \`gh pr checks ${pullRequestNumber}\` and \`gh run view --log-failed\`, then fix the root cause; (4) run verification: ${VERIFY_COMMAND} at the repository root; (5) commit and push. Do NOT merge the PR — just make it green and conflict-free, then report.${gateNote}`;
}
