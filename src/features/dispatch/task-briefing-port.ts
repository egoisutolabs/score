import type { IssueObservation } from "@/features/dispatch/issue";
import type { WorkIdentity } from "@/features/dispatch/work";

export interface TaskBriefingWriter {
  write(issue: IssueObservation, identity: WorkIdentity): Promise<void>;
}
