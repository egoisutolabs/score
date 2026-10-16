/**
 * One review thread as GitHub reports it, reduced to what keying and
 * classification need. Positions come from the commit the reviewer wrote
 * against (`originalCommit`/`originalLine`), never from the moving head, so a
 * thread keeps one key for its whole life.
 */
export interface ReviewThreadObservation {
  readonly id: string;
  readonly path: string;
  readonly originalLine: number | null;
  readonly originalCommit: string | undefined;
  /** Login of the root comment's author; undefined for a deleted account. */
  readonly author: string | undefined;
  readonly createdAt: string;
  readonly isResolved: boolean;
  readonly resolvedBy: string | undefined;
}

/**
 * Review-loop analysis §2.4. `first-round` is the first review of a PR,
 * before any repair wave: a first-draft defect, outside the table.
 */
export type FindingClass =
  | "first-round"
  | "fix-failed"
  | "duplicate"
  | "regression-from-fix"
  | "missed-earlier";

/**
 * A self-resolve is the agent (on the operator's token) closing a reviewer's
 * thread. The ledger keeps it apart from a reviewer's own close because the
 * convergence rules count it as still open.
 */
export type FindingResolution = "open" | "self-resolved" | "reviewer-resolved";

export interface FindingRecord {
  readonly threadId: string;
  /** blame origin (or the reviewed commit) + path + enclosing symbol (or line). */
  readonly key: string;
  readonly path: string;
  readonly symbol: string | undefined;
  readonly origin: string | undefined;
  readonly author: string | undefined;
  readonly createdAt: string;
  readonly class: FindingClass;
  /** Repair waves the PR had received when this thread first appeared. */
  readonly wave: number;
  /** Blame places the cited line after the head the latest wave was sent to fix: the fix introduced it. */
  readonly fromLastFix: boolean;
  /** A classifier's probability the finding is real; absent with the default classifier. */
  readonly real?: number;
  readonly resolution: FindingResolution;
  readonly resolvedBy: string | undefined;
}

/** Read-only git facts the keyer needs; GitService implements it on the primary checkout. */
export interface BlameSource {
  /** Commit that last touched `line` of `path` as of `commit`; undefined when blame cannot say. */
  blameOrigin(commit: string, path: string, line: number): Promise<string | undefined>;
  /** Full contents of `path` at `commit`; undefined when the path is absent there. */
  fileAt(commit: string, path: string): Promise<string | undefined>;
}

/** The per-PR finding memory the tracker reads and writes; the daemon's RepairLedger implements it. */
export interface FindingLedger {
  findings(pullRequestNumber: number): readonly FindingRecord[];
  /** Head commit when the first repair wave was sent; undefined before that. */
  firstHead(pullRequestNumber: number): string | undefined;
  /** Head commit the latest wave was sent to fix; undefined before any wave. */
  lastWaveHead(pullRequestNumber: number): string | undefined;
  waveCount(pullRequestNumber: number): number;
  recordFindings(pullRequestNumber: number, records: readonly FindingRecord[]): void;
}
