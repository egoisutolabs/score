import { basename, relative } from "node:path";
import { isIssueBranch } from "@score/core/dispatch/dispatch.identity";
import type { WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { IssueObservation } from "./issue.interface";

export interface IssuePolicy {
  readonly eligibleLabelPrefix: string;
  readonly holdLabel: string;
  readonly umbrellaLabel: string;
}

/** Legacy candidate filtering happens once, before the mutation-time issue refresh. */
export function isOpenChildIssue(issue: IssueObservation, policy: IssuePolicy): boolean {
  const labels = issue.labels.map((label) => label.name);
  return (
    issue.state === "OPEN" &&
    labels.some((label) => label.startsWith(policy.eligibleLabelPrefix)) &&
    !labels.includes(policy.holdLabel) &&
    !labels.includes(policy.umbrellaLabel)
  );
}

export function hasLabel(issue: IssueObservation, label: string): boolean {
  return issue.labels.some((candidate) => candidate.name === label);
}

/** Dependency grammar is copied from the legacy autopilot. */
export function parseDependencies(body: string): readonly number[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Dependencies\s*$/i.test(line.trim()));
  if (start === -1) return [];

  const dependencies: number[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) break;
    const match = /^-\s+#(\d+)\b/.exec(trimmed);
    if (match?.[1]) dependencies.push(Number.parseInt(match[1], 10));
  }
  return dependencies;
}

export function sortIssuesForDispatch(
  issues: readonly IssueObservation[],
): readonly IssueObservation[] {
  return [...issues].sort((left, right) => left.number - right.number);
}

/**
 * Branch identity of a worktree observation. A detached-HEAD worktree reports
 * an empty branch, but our worktree paths are minted as workspaceRoot/branch
 * (createWorkIdentity), so the basename carries the same identity — every
 * consumer of a worktree's branch must fall back to it or a detached worktree
 * silently leaves that consumer's universe while still holding a slot.
 */
export function worktreeBranchIdentity(worktree: WorktreeObservation): string {
  return worktree.branch || basename(worktree.path);
}

/** Legacy ownership accepts the issue pattern from either branch or detached-worktree basename. */
export function isOwnedIssueWorktree(
  worktree: WorktreeObservation,
  workspaceRoot: string,
): boolean {
  const path = relative(workspaceRoot, worktree.path);
  return (
    path !== "" &&
    !path.startsWith("..") &&
    !path.startsWith("/") &&
    isIssueBranch(worktreeBranchIdentity(worktree))
  );
}
