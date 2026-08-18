/** One daemon decision event adapted from the server stream for history folds. */
export interface HistoryEvent {
  readonly project: string;
  readonly ts: string;
  readonly name: string;
  readonly subject?: {
    readonly issue_number?: number;
    readonly pull_request_number?: number;
  };
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

/** A merge fact observed from GitHub through the server's read-only endpoint. */
export interface GitHubMerge {
  readonly project: string;
  readonly pullRequest: number;
  readonly title: string;
  readonly mergedTs: string;
}

export interface HistoryProjectRow {
  readonly project: string;
  readonly merged: number;
  readonly share: number | null;
  readonly latestTs: string | null;
}

export interface HistoryMergeRow {
  readonly project: string;
  readonly pullRequest: number;
  readonly mergedTs: string;
  readonly title: string | null;
}

export interface HistoryOverview {
  readonly merged: number;
  readonly activeProjects: number;
  readonly busiestDay: number;
  readonly latestTs: string | null;
  readonly startDay: string;
  readonly endDay: string;
  readonly mergesByDay: readonly number[];
  readonly byProject: readonly HistoryProjectRow[];
  readonly recent: readonly HistoryMergeRow[];
}
