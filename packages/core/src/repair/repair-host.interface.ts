/**
 * The few GitHub mutations repair performs itself, when a PR's round budget
 * runs out. Everything else repair does goes through an agent. Kept apart
 * from ChangeHost (observation only) so the pass-cached wrapper and the
 * landing fakes never grow mutation methods they must not call.
 */
export interface RepairHost {
  /** Adds the label, creating it in the repository if missing. Re-adding is a no-op. */
  addLabel(pullRequestNumber: number, label: string): Promise<void>;
  /** Whether any comment on the PR's conversation contains `marker` verbatim. */
  hasComment(pullRequestNumber: number, marker: string): Promise<boolean>;
  comment(pullRequestNumber: number, body: string): Promise<void>;
}
