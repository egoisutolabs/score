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

/** One constructor owns branch, worktree, and session naming for every phase. */
export function createWorkIdentity(workspaceRoot: string, issue: IssueObservation): WorkIdentity {
  if (!isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be absolute");

  const branch = `issue-${issue.number}-${slugifyIssueTitle(issue.title)}`;
  return {
    issueNumber: issue.number,
    branch,
    worktreePath: join(workspaceRoot, branch),
    sessionName: `issue-${issue.number}`,
  };
}

export function issueNumberFromBranch(branch: string): number | null {
  const match = /^issue-(\d+)-/.exec(branch);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}
