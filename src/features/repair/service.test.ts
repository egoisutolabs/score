import { expect, test } from "vitest";

import type { WorkIdentity, WorktreeObservation } from "@/features/dispatch/work";
import type { PullRequestObservation } from "@/features/landing/change";
import type { ChangeHost } from "@/features/landing/port";
import { RepairService } from "@/features/repair/service";
import type { AgentRuntime } from "@/shared/agent-runtime";
import type { PrimaryCheckoutObservation, WorkspaceDriver } from "@/shared/workspace-driver";

function change(): PullRequestObservation {
  return {
    number: 9,
    title: "Repair",
    headRefName: "issue-3-repair",
    isDraft: false,
    mergeable: "CONFLICTING",
    reviewDecision: null,
    labels: [],
    files: [],
    statusCheckRollup: [],
  };
}

class RepairWorkspace implements WorkspaceDriver {
  worktrees: WorktreeObservation[] = [];
  async observeWorktrees() {
    return this.worktrees;
  }
  async createWorktree(_identity: WorkIdentity): Promise<void> {}
  async status() {
    return "";
  }
  async removeWorktree() {}
  async deleteBranch() {
    return true;
  }
  async observePrimaryCheckout(): Promise<PrimaryCheckoutObservation> {
    return { branch: "main", status: "" };
  }
  async fetchOrigin() {}
  async stageMerge() {
    return true;
  }
  async abortMerge() {}
  async commitMerge() {}
  async pushDefaultBranch() {}
  async fastForwardDefaultBranch() {
    return true;
  }
}

class RepairAgents implements AgentRuntime {
  sessions: string[] = [];
  pinged: string[] = [];
  spawned: number[] = [];
  async sessionExists() {
    return false;
  }
  async listSessions() {
    return this.sessions;
  }
  async startImplementation() {}
  async ping(sessionName: string) {
    this.pinged.push(sessionName);
  }
  async startRepair(pullRequestNumber: number) {
    this.spawned.push(pullRequestNumber);
  }
  async stop() {}
}

function changes(): ChangeHost {
  return {
    async observeOpenChanges() {
      return [change()];
    },
    async observeMergedOwnedChanges() {
      return [];
    },
    async observeOpenChangeHeads() {
      return [];
    },
    async observeRepairChanges() {
      return [change()];
    },
    async unresolvedThreadCount() {
      return 0;
    },
  };
}

const options = {
  agentCommand: "claude",
  verificationCommands: "bun test",
  sessionSuffix: "-issue-%N",
  includeClean: false,
  onlyPullRequests: new Set<string>(),
  noSpawn: false,
};

test("repair pings the matching live issue session even without a worktree", async () => {
  const workspace = new RepairWorkspace();
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const result = await new RepairService(options, changes(), workspace, agents).run();
  expect(result[0]?.action).toBe("PINGED");
  expect(agents.pinged).toEqual(["score-issue-3"]);
});

test("shouldAct=false reports WORKING and touches no session", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const asked: number[] = [];
  const result = await new RepairService(
    {
      ...options,
      shouldAct: (pullRequestNumber) => {
        asked.push(pullRequestNumber);
        return false;
      },
    },
    changes(),
    new RepairWorkspace(),
    agents,
  ).run();
  expect(result[0]?.action).toBe("WORKING");
  expect(asked).toEqual([9]);
  expect(agents.pinged).toEqual([]);
});

test("repair spawns shepherd-pr work in the exact existing PR worktree", async () => {
  const workspace = new RepairWorkspace();
  workspace.worktrees = [{ path: "/wt/issue-3-repair", branch: "issue-3-repair", locked: false }];
  const agents = new RepairAgents();
  const result = await new RepairService(options, changes(), workspace, agents).run();
  expect(result[0]?.action).toBe("SPAWNED");
  expect(agents.spawned).toEqual([9]);
});

test("review-thread query failure retains shepherd's fail-open zero", async () => {
  const workspace = new RepairWorkspace();
  const agents = new RepairAgents();
  const clean = { ...change(), mergeable: "MERGEABLE" as const };
  const host: ChangeHost = {
    async observeOpenChanges() {
      return [clean];
    },
    async observeMergedOwnedChanges() {
      return [];
    },
    async observeOpenChangeHeads() {
      return [];
    },
    async observeRepairChanges() {
      return [clean];
    },
    async unresolvedThreadCount() {
      throw new Error("graphql failed");
    },
  };
  const result = await new RepairService(options, host, workspace, agents).run();
  expect(result[0]?.action).toBe("NOT_NEEDED");
});
