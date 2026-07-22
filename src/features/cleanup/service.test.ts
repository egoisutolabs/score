import { expect, test } from "vitest";
import { CleanupService } from "@/features/cleanup/service";
import type { WorkIdentity, WorktreeObservation } from "@/features/dispatch/work";
import type { PullRequestObservation } from "@/features/landing/change";
import type { ChangeHost } from "@/features/landing/port";
import type { AgentRuntime } from "@/shared/agent-runtime";
import type { PrimaryCheckoutObservation, WorkspaceDriver } from "@/shared/workspace-driver";

const worktree = { path: "/wt/issue-1-done", branch: "issue-1-done", locked: false };
const merged: PullRequestObservation = {
  number: 4,
  title: "Done",
  headRefName: worktree.branch,
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  labels: [],
  files: [],
  statusCheckRollup: [],
};

class CleanupWorkspace implements WorkspaceDriver {
  fastForwards = 0;
  deleted = 0;
  async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
    return [worktree];
  }
  async createWorktree(_identity: WorkIdentity) {}
  async status() {
    return "?? TASK.md\n";
  }
  async removeWorktree() {}
  async deleteBranch() {
    this.deleted += 1;
    return false;
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
    this.fastForwards += 1;
    return true;
  }
}

const host: ChangeHost = {
  async observeOpenChanges() {
    return [];
  },
  async observeMergedOwnedChanges() {
    return [merged];
  },
  async observeOpenChangeHeads() {
    return [];
  },
  async observeRepairChanges() {
    return [];
  },
  async unresolvedThreadCount() {
    return 0;
  },
};
const agents: AgentRuntime = {
  async sessionExists() {
    return false;
  },
  async listSessions() {
    return [];
  },
  async startImplementation() {},
  async ping() {},
  async startRepair() {},
  async stop() {},
};

test("dry-run safe cleanup still plans the legacy pull-main observation", async () => {
  const workspace = new CleanupWorkspace();
  const result = await new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: true,
    },
    host,
    workspace,
    agents,
  ).run(true);
  expect(result[0]?.action).toBe("PLANNED");
  expect(workspace.fastForwards).toBe(1);
});

test("local branch deletion failure remains nonfatal after worktree removal", async () => {
  const workspace = new CleanupWorkspace();
  const result = await new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: true,
    },
    host,
    workspace,
    agents,
  ).run(false);
  expect(result[0]?.action).toBe("CLEANED");
  expect(workspace.deleted).toBe(1);
  expect(workspace.fastForwards).toBe(1);
});
