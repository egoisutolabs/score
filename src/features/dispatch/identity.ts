import { isAbsolute, join } from "node:path";

import type { IssueObservation } from "@/features/dispatch/issue";
import type { WorkIdentity } from "@/features/dispatch/work";

/** Stable, human-readable slug retained from the legacy work convention. */
export function slugifyIssueTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/^\[\d+\]\s*/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/g, "") || "issue"
  );
}

/**
 * Session-name authority. A managed daemon passes its project key as the
 * namespace so two projects sharing issue numbers cannot touch each other's
 * agents; the key charset ([a-z0-9-], enforced in config load) keeps every
 * name a valid tmux target (no ":" or ".").
 */
export function sessionNameForIssue(namespace: string | undefined, issueNumber: number): string {
  return namespace === undefined
    ? `issue-${issueNumber}`
    : `score-${namespace}-issue-${issueNumber}`;
}

export function repairSessionName(
  namespace: string | undefined,
  pullRequestNumber: number,
): string {
  return namespace === undefined
    ? `shepherd-pr-${pullRequestNumber}`
    : `score-${namespace}-shepherd-pr-${pullRequestNumber}`;
}

/** One constructor owns branch, worktree, and session naming for every phase. */
export function createWorkIdentity(
  workspaceRoot: string,
  issue: IssueObservation,
  namespace?: string,
): WorkIdentity {
  if (!isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be absolute");

  // Branches stay un-namespaced deliberately: they live per-repo.
  const branch = `issue-${issue.number}-${slugifyIssueTitle(issue.title)}`;
  return {
    issueNumber: issue.number,
    branch,
    worktreePath: join(workspaceRoot, branch),
    sessionName: sessionNameForIssue(namespace, issue.number),
  };
}

export function issueNumberFromBranch(branch: string): number | null {
  const match = /^issue-(\d+)-/.exec(branch);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}
