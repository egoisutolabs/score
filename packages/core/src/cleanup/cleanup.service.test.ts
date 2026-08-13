import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { CleanupService } from "@score/core/cleanup/cleanup.service";
import type { WorkIdentity, WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { PullRequestObservation } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type {
  PrimaryCheckoutObservation,
  WorkspaceDriver,
} from "@score/core/workspace-driver.interface";
import { expect, test } from "vitest";

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
function makeAgents(): AgentRuntime & { stopped: string[] } {
  return {
    stopped: [],
    async sessionExists() {
      return false;
    },
    async listSessions() {
      return [];
    },
    async startImplementation() {},
    async ping() {},
    async startRepair() {},
    async stop(sessionName: string) {
      this.stopped.push(sessionName);
    },
  };
}

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
    makeAgents(),
  ).run(true);
  expect(result[0]?.action).toBe("PLANNED");
  expect(workspace.fastForwards).toBe(1);
});

test("local branch deletion failure remains nonfatal after worktree removal", async () => {
  const workspace = new CleanupWorkspace();
  const agents = makeAgents();
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
  expect(agents.stopped).toEqual(["issue-1"]);
  expect(workspace.deleted).toBe(1);
  expect(workspace.fastForwards).toBe(1);
});

// Boundary audit (#42): child dies between removeWorktree and deleteBranch —
// or deleteBranch simply fails (GitService reports nonzero `branch -d` as
// `false`, never a throw). The leftover local branch must be benign.
test("cleanup: deleteBranch fails after removeWorktree — next pass reports NOT_FOUND, no retry loop (BENIGN-LEFTOVER)", async () => {
  class StrandedWorkspace extends CleanupWorkspace {
    live: WorktreeObservation[] = [worktree];
    override async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
      return this.live;
    }
    override async removeWorktree(): Promise<void> {
      this.live = [];
    }
  }
  const workspace = new StrandedWorkspace();
  const service = new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: false,
    },
    host,
    workspace,
    makeAgents(),
  );

  const first = await service.run(false);
  expect(first[0]?.action).toBe("CLEANED"); // branch-delete failure is a warning, not failed cleanup
  expect(workspace.deleted).toBe(1);

  // Next tick still observes the merged PR, but the worktree is gone: cleanup
  // must not loop on the leftover branch. Its other half of benignity — a
  // same-numbered redispatch reattaching to it — is pinned by git.service.test.ts
  // "existing issue branches are attached without creating a second branch".
  const second = await service.run(false);
  expect(second[0]?.action).toBe("NOT_FOUND");
  expect(workspace.deleted).toBe(1);
});

test("namespaced cleanup stops the exact session its dispatch created", async () => {
  const agents = makeAgents();
  const result = await new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: false,
      namespace: "demo",
    },
    host,
    new CleanupWorkspace(),
    agents,
  ).run(false);
  expect(result[0]?.action).toBe("CLEANED");
  expect(agents.stopped).toEqual(["score-demo-issue-1"]);
});
