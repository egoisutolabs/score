import type { WorkIdentity } from "@/features/dispatch/work";

export interface AgentRuntime {
  sessionExists(sessionName: string): Promise<boolean>;
  listSessions(): Promise<readonly string[]>;
  startImplementation(identity: WorkIdentity, prompt: string): Promise<void>;
  ping(sessionName: string, message: string): Promise<void>;
  startRepair(
    pullRequestNumber: number,
    worktreePath: string,
    message: string,
    agentCommand: string,
  ): Promise<void>;
  stop(sessionName: string): Promise<void>;
}
