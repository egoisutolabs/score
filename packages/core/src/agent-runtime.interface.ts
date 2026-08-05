import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";

export interface AgentRuntime {
  sessionExists(sessionName: string): Promise<boolean>;
  listSessions(): Promise<readonly string[]>;
  startImplementation(identity: WorkIdentity, prompt: string, agent: AgentConfig): Promise<void>;
  ping(sessionName: string, message: string): Promise<void>;
  startRepair(
    pullRequestNumber: number,
    worktreePath: string,
    message: string,
    agent: AgentConfig,
  ): Promise<void>;
  stop(sessionName: string): Promise<void>;
}
