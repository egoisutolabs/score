/**
 * Must match the session names dispatch creates (`issue-N` in identity.ts).
 * Legacy defaulted to "-issue-%N", which never matched its own "issue-N"
 * sessions, so repair silently always spawned instead of pinging. Anchored so
 * an unrelated session like "my-issue-1" can't be pinged by mistake.
 */
export const DEFAULT_SESSION_SUFFIX = "^issue-%N";

export interface RepairDefects {
  readonly conflicting: boolean;
  readonly unresolvedThreads: number;
  readonly failingChecks: number;
}

export function needsRepair(defects: RepairDefects): boolean {
  return defects.conflicting || defects.unresolvedThreads > 0 || defects.failingChecks > 0;
}

/** Repair prompt names every defect class while explicitly withholding merge authority. */
export function renderRepairPrompt(
  pullRequestNumber: number,
  verificationCommands: string,
): string {
  return `Follow-up on your PR #${pullRequestNumber}: it needs cleanup before it can land. Please do all of: (1) git fetch origin && merge origin/main into this branch, resolving every conflict correctly per the code's intent; (2) address any unresolved review threads — list them with gh api graphql reviewThreads where isResolved is false, fix each in code, then resolve via resolveReviewThread; (3) check failing CI with \`gh pr checks ${pullRequestNumber}\` and \`gh run view --log-failed\`, then fix the root cause; (4) run verification: ${verificationCommands}; (5) commit and push. Do NOT merge the PR — just make it green and conflict-free, then report.`;
}
