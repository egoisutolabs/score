import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { CleanupService } from "@score/core/cleanup/cleanup.service";
import type { WorkIdentity, WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { PullRequestObservation } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { LandingWorkspace, WorktreeProvisioner } from "@score/core/workspace-driver.interface";
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

class CleanupWorkspace
  implements WorktreeProvisioner, Pick<LandingWorkspace, "fastForwardDefaultBranch">
{
  fastForwards = 0;
  deleted = 0;
  async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
    return [worktree];
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
  async fastForwardDefaultBranch() {
    this.fastForwards += 1;
    return true;
  }
  async isAncestor() {
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

// --- Stranded-issue ladder (#64) -------------------------------------------
// A worktree whose branch has no PR at all: ping after a silent window,
// reclaim after a second one (immediately when the session is gone), and
// never destroy real work.

const strandedWorktree: WorktreeObservation = {
  path: "/wt/issue-21-fix",
  branch: "issue-21-fix",
  headSha: "base-sha",
  locked: false,
};

/** No PRs anywhere: the stranded scan is the only observer left. */
const emptyHost: ChangeHost = {
  async observeOpenChanges() {
    return [];
  },
  async observeMergedOwnedChanges() {
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

class StrandedFixtureWorkspace extends CleanupWorkspace {
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
  override async isAncestor() {
    return this.ancestor;
  }
}

function makeStrandedAgents(sessions: string[]): AgentRuntime & {
  stopped: string[];
  pinged: { session: string; message: string }[];
} {
  return {
    stopped: [],
    pinged: [],
    async sessionExists(sessionName: string) {
      return sessions.includes(sessionName);
    },
    async listSessions() {
      return sessions;
    },
    async startImplementation() {},
    async ping(session: string, message: string) {
      this.pinged.push({ session, message });
    },
    async startRepair() {},
    async stop(sessionName: string) {
      this.stopped.push(sessionName);
    },
  };
}

function makeStrandedService(
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
    },
    host,
    workspace,
    agents,
  );
}

// #21's exact shape: worktree present, tmux session alive, zero commits, no
// PR — the state that leaked a slot for two days.
test("stranded (#64): live session with no PR and no commits — first window pings, second reclaims", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents(["issue-21"]);
  const service = makeStrandedService(workspace, agents);

  // Tick 0: freshly observed, inside the first window — nothing happens.
  expect(await service.run(false)).toEqual([]);

  // Tick 1: first silent window over — ping, don't touch the worktree.
  const pinged = await service.run(false);
  expect(pinged).toEqual([{ issueNumber: 21, action: "STRANDED_PINGED", dryRun: false }]);
  expect(agents.pinged).toHaveLength(1);
  expect(agents.pinged[0]?.session).toBe("issue-21");
  expect(agents.pinged[0]?.message).toContain("no PR observed for issue #21");
  expect(workspace.removed).toEqual([]);

  // Tick 2: second silent window over — reclaim with cleanup's verb sequence.
  const reclaimed = await service.run(false);
  expect(reclaimed).toEqual([{ issueNumber: 21, action: "STRANDED_RECLAIMED", dryRun: false }]);
  expect(agents.stopped).toEqual(["issue-21"]);
  expect(workspace.removed).toEqual(["/wt/issue-21-fix"]);
  expect(workspace.deletedBranches).toEqual(["issue-21-fix"]);
  // All three in-flight witnesses (worktree, session, open PR) are now clear,
  // so dispatch's #alreadyInFlight passes and the issue redispatches next
  // tick — reattachment to a surviving branch is pinned by git.service.test.ts.
});

test("stranded (#64): missing session reclaims immediately, without a ping", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents([]);
  const service = makeStrandedService(workspace, agents);

  const result = await service.run(false);
  expect(result).toEqual([{ issueNumber: 21, action: "STRANDED_RECLAIMED", dryRun: false }]);
  expect(agents.pinged).toEqual([]);
  expect(workspace.removed).toEqual(["/wt/issue-21-fix"]);
});

test("stranded (#64): uncommitted work is never removed — STRANDED_DIRTY every tick", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.worktreeStatus = " M src/app.ts\n";
  const service = makeStrandedService(workspace, makeStrandedAgents([]));

  for (let tick = 0; tick < 2; tick++) {
    const result = await service.run(false);
    expect(result).toEqual([
      {
        issueNumber: 21,
        action: "STRANDED_DIRTY",
        dryRun: false,
        message: "worktree contains changes outside the harness allowlist",
      },
    ]);
  }
  expect(workspace.removed).toEqual([]);
  expect(workspace.deletedBranches).toEqual([]);
});

test("stranded (#64): commits ahead of base are never removed — STRANDED_DIRTY every tick", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.ancestor = false;
  const service = makeStrandedService(workspace, makeStrandedAgents([]));

  for (let tick = 0; tick < 2; tick++) {
    const result = await service.run(false);
    expect(result).toEqual([
      {
        issueNumber: 21,
        action: "STRANDED_DIRTY",
        dryRun: false,
        message: "branch has commits not on the base branch",
      },
    ]);
  }
  expect(workspace.removed).toEqual([]);
});

test("stranded (#64): a branch with an open PR is repair's domain — never touched", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents([]);
  const withOpenPr: ChangeHost = {
    ...emptyHost,
    async observeOpenChangeHeads() {
      return [{ number: 99, headRefName: strandedWorktree.branch }];
    },
  };
  const service = makeStrandedService(workspace, agents, withOpenPr);

  expect(await service.run(false)).toEqual([]);
  expect(await service.run(false)).toEqual([]);
  expect(agents.pinged).toEqual([]);
  expect(workspace.removed).toEqual([]);
});

test("stranded (#64): a new commit restarts the silence window", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents(["issue-21"]);
  const service = makeStrandedService(workspace, agents);

  await service.run(false); // tick 0: window opens on base-sha
  workspace.live = [{ ...strandedWorktree, headSha: "new-commit" }];
  expect(await service.run(false)).toEqual([]); // tick 1: progress — no ping
  const pinged = await service.run(false); // tick 2: new window over — ping
  expect(pinged).toEqual([{ issueNumber: 21, action: "STRANDED_PINGED", dryRun: false }]);
});

test("stranded (#64): dry-run plans the ping and the reclaim, mutates nothing", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents(["issue-21"]);
  const service = makeStrandedService(workspace, agents);

  await service.run(true); // tick 0: waiting
  const pinged = await service.run(true);
  expect(pinged).toEqual([{ issueNumber: 21, action: "STRANDED_PINGED", dryRun: true }]);
  expect(agents.pinged).toEqual([]);
  // The dry-run ping never reached the agent, so the reclaim clock has not
  // started: the next tick still pings instead of reclaiming.
  const again = await service.run(true);
  expect(again).toEqual([{ issueNumber: 21, action: "STRANDED_PINGED", dryRun: true }]);

  const deadAgents = makeStrandedAgents([]);
  const deadWorkspace = new StrandedFixtureWorkspace();
  const deadService = makeStrandedService(deadWorkspace, deadAgents);
  const planned = await deadService.run(true);
  expect(planned).toEqual([{ issueNumber: 21, action: "STRANDED_RECLAIMED", dryRun: true }]);
  expect(deadAgents.stopped).toEqual([]);
  expect(deadWorkspace.removed).toEqual([]);
  expect(deadWorkspace.deletedBranches).toEqual([]);
});

// Boundary audit (INVARIANTS Rule 1): a death after each reclaim step
// converges on the next tick.
test("stranded (#64): death after stop, before removeWorktree — next tick re-reclaims (RETRIED)", async () => {
  class DiesAfterStop extends StrandedFixtureWorkspace {
    dieOnce = true;
    override async removeWorktree(worktree: WorktreeObservation): Promise<void> {
      if (this.dieOnce) {
        this.dieOnce = false;
        throw new Error("killed between stop and removeWorktree");
      }
      await super.removeWorktree(worktree);
    }
  }
  const workspace = new DiesAfterStop();
  const agents = makeStrandedAgents([]);
  const service = makeStrandedService(workspace, agents);

  await expect(service.run(false)).rejects.toThrow("killed between stop");
  expect(workspace.removed).toEqual([]);

  // Next tick: the session is (still) gone, so the reclaim re-enters and
  // completes; the repeated stop is a tolerated no-op (tmux kill-session of
  // a missing session never throws — see TmuxService.stop).
  const result = await service.run(false);
  expect(result).toEqual([{ issueNumber: 21, action: "STRANDED_RECLAIMED", dryRun: false }]);
  expect(workspace.removed).toEqual(["/wt/issue-21-fix"]);
  expect(workspace.deletedBranches).toEqual(["issue-21-fix"]);
});

test("stranded (#64): death after removeWorktree, before deleteBranch — leftover branch is benign, no retry loop (BENIGN-LEFTOVER)", async () => {
  class DiesAfterRemove extends StrandedFixtureWorkspace {
    dieOnce = true;
    override async deleteBranch(branch: string) {
      if (this.dieOnce) {
        this.dieOnce = false;
        throw new Error("killed between removeWorktree and deleteBranch");
      }
      return super.deleteBranch(branch);
    }
  }
  const workspace = new DiesAfterRemove();
  const service = makeStrandedService(workspace, makeStrandedAgents([]));

  await expect(service.run(false)).rejects.toThrow("killed between removeWorktree");
  expect(workspace.removed).toEqual(["/wt/issue-21-fix"]);

  // Next tick: the worktree is gone, so nothing is stranded; the surviving
  // branch is the same benign leftover as merged cleanup's — redispatch
  // reattaches to it (git.service.test.ts pins the reattachment).
  expect(await service.run(false)).toEqual([]);
  expect(workspace.deletedBranches).toEqual([]);
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
