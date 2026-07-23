import type { AgentConfig } from "@/features/config/model";
import type { WorkIdentity } from "@/features/dispatch/work";

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
