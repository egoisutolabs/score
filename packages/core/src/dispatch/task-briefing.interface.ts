import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import type { IssueObservation } from "./issue.interface";

export interface TaskBriefingWriter {
  write(issue: IssueObservation, identity: WorkIdentity): Promise<void>;
}
