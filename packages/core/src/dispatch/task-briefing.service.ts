import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import type { TaskBriefingWriter } from "@score/core/dispatch/task-briefing.interface";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import { renderBriefing } from "@score/core/prompts/briefing.render";
import type { AgentConfig } from "@score/shared/config/config.interface";

/** Writes the briefing (prompts/briefing.render.ts) as TASK.md in the issue's worktree. */
export class TaskBriefingService implements TaskBriefingWriter {
  render(issue: IssueObservation, identity: WorkIdentity, agent: AgentConfig): string {
    return renderBriefing(issue, identity, agent);
  }

  async write(issue: IssueObservation, identity: WorkIdentity, agent: AgentConfig): Promise<void> {
    writeFileSync(
      join(identity.worktreePath, "TASK.md"),
      this.render(issue, identity, agent),
      "utf8",
    );
  }
}
