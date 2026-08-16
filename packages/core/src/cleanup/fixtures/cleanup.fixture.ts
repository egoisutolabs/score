// Fixtures for the cleanup tests: the merged-PR shape legacy cleanup acts
// on, and the stranded shape from #64 (a worktree whose branch has no PR at
// all). Branch shapes derive from dispatch.identity — the boundary test
// forbids shape literals outside the authority module, tests excepted.
import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { CleanupService } from "@score/core/cleanup/cleanup.service";
import { issueBranchPrefix } from "@score/core/dispatch/dispatch.identity";
import type { WorkIdentity, WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { PullRequestObservation } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { LandingWorkspace, WorktreeProvisioner } from "@score/core/workspace-driver.interface";

export const mergedBranch = `${issueBranchPrefix(1)}done`;
export const mergedWorktree: WorktreeObservation = {
  path: `/wt/${mergedBranch}`,
  branch: mergedBranch,
  locked: false,
};
export const merged: PullRequestObservation = {
  number: 4,
  title: "Done",
  headRefName: mergedBranch,
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  labels: [],
  files: [],
  statusCheckRollup: [],
};

export class CleanupWorkspace
  implements
    WorktreeProvisioner,
    Pick<LandingWorkspace, "fastForwardDefaultBranch" | "observePrimaryCheckout">
{
  fastForwards = 0;
  deleted = 0;
  primaryStatus = "";
  async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
    return [mergedWorktree];
  }
  async createWorktree(_identity: WorkIdentity) {}
  async status() {
    return "?? TASK.md\n";
  }
  async removeWorktree(_worktree: WorktreeObservation) {}
  async deleteBranch(_branch: string) {
    this.deleted += 1;
    return false;
  }
  async observePrimaryCheckout() {
    return { branch: "main", status: this.primaryStatus };
  }
  // Mirrors GitService: the attempt refuses (returns false) on a dirty primary.
  async fastForwardDefaultBranch() {
    this.fastForwards += 1;
    return this.primaryStatus === "";
  }
  async isAncestor(_ancestor: string, _descendant: string) {
    return true;
  }
}

export const mergedHost: ChangeHost = {
  async observeOpenChanges() {
    return [];
  },
  async observeMergedOwnedChanges() {
    return [merged];
  },
  async observeClosedOwnedChanges() {
    return [];
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

export function makeAgents(): AgentRuntime & { stopped: string[] } {
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

// --- Stranded-issue ladder (#64) -------------------------------------------

export const strandedIssueNumber = 21;
export const strandedBranch = `${issueBranchPrefix(strandedIssueNumber)}fix`;
export const strandedHeadSha = "base-sha";
export const strandedWorktree: WorktreeObservation = {
  path: `/wt/${strandedBranch}`,
  branch: strandedBranch,
  headSha: strandedHeadSha,
  locked: false,
};

/** No PRs anywhere: the stranded scan is the only observer left. */
export const emptyHost: ChangeHost = {
  ...mergedHost,
  async observeMergedOwnedChanges() {
    return [];
  },
};

export class StrandedFixtureWorkspace extends CleanupWorkspace {
  live: WorktreeObservation[] = [strandedWorktree];
  removed: string[] = [];
  deletedBranches: string[] = [];
  worktreeStatus = "?? TASK.md\n";
  ancestor = true;
  override async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
    return this.live;
  }
  override async status() {
    return this.worktreeStatus;
  }
  override async removeWorktree(worktree: WorktreeObservation): Promise<void> {
    this.removed.push(worktree.path);
    this.live = this.live.filter((candidate) => candidate.path !== worktree.path);
  }
  override async deleteBranch(branch: string) {
    this.deletedBranches.push(branch);
    return true;
  }
  // Only the untouched base head counts as merged-into-base, so a race that
  // commits mid-reclaim (new headSha) reads as "commits ahead", like real git.
  override async isAncestor(ancestor: string) {
    return this.ancestor && ancestor === strandedHeadSha;
  }
}

export function makeStrandedAgents(sessions: string[]): AgentRuntime & {
  sessions: string[];
  stopped: string[];
  pinged: { session: string; message: string }[];
  started: WorkIdentity[];
} {
  return {
    sessions,
    stopped: [],
    pinged: [],
    started: [],
    async sessionExists(sessionName: string) {
      return this.sessions.includes(sessionName);
    },
    async listSessions() {
      return this.sessions;
    },
    // Respawns register as live sessions so convergence tests can observe
    // the revived agent the way the next tick's sessionExists would.
    async startImplementation(identity: WorkIdentity) {
      this.started.push(identity);
      this.sessions.push(identity.sessionName);
    },
    async ping(session: string, message: string) {
      this.pinged.push({ session, message });
    },
    async startRepair() {},
    async stop(sessionName: string) {
      this.stopped.push(sessionName);
      this.sessions = this.sessions.filter((candidate) => candidate !== sessionName);
    },
  };
}

export function makeStrandedService(
  workspace: StrandedFixtureWorkspace,
  agents: AgentRuntime,
  host: ChangeHost = emptyHost,
) {
  return new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: false,
      staleTicks: 1,
      agent: { harness: "claude" },
    },
    host,
    workspace,
    agents,
  );
}
