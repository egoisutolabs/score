import type { WorkIdentity } from "@score/core/dispatch/work";
import type { IssueObservation } from "./issue";

export interface TaskBriefingWriter {
  write(issue: IssueObservation, identity: WorkIdentity): Promise<void>;
}
