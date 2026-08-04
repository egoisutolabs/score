export interface Label {
  readonly name: string;
}

export interface IssueComment {
  readonly author?: { readonly login: string } | null;
  readonly body: string;
}

/** GitHub issue fields used by the legacy dispatcher. */
export interface IssueObservation {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly Label[];
  readonly state: "OPEN" | "CLOSED";
  readonly stateReason?: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
  readonly url: string;
  readonly comments: readonly IssueComment[];
}

export interface DependencyObservation {
  readonly number: number;
  readonly state: string;
  readonly stateReason?: string | null;
}
