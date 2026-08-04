import type { DependencyObservation, IssueObservation } from "./issue";

export interface WorkSource {
  observeIssues(): Promise<readonly IssueObservation[]>;
  observeIssue(issueNumber: number): Promise<IssueObservation>;
  observeDependency(issueNumber: number): Promise<DependencyObservation>;
}
