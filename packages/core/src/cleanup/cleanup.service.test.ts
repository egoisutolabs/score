import { CleanupService } from "@score/core/cleanup/cleanup.service";
import type { WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import { expect, test } from "vitest";
import {
  CleanupWorkspace,
  emptyHost,
  makeAgents,
  makeStrandedAgents,
  makeStrandedService,
  mergedHost,
  mergedWorktree,
  StrandedFixtureWorkspace,
  strandedWorktree,
} from "./fixtures";

test("dry-run safe cleanup still plans the legacy pull-main observation", async () => {
  const workspace = new CleanupWorkspace();
  const result = await new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: true,
      agent: { harness: "claude" },
    },
    mergedHost,
    workspace,
    makeAgents(),
  ).run(true);
  expect(result[0]?.action).toBe("PLANNED");
  expect(workspace.fastForwards).toBe(1);
});

test("a dirty primary reports the auto-pull refusal with the blocking paths, every pass (#91)", async () => {
  const workspace = new CleanupWorkspace();
  workspace.primaryStatus = "?? apps/web/.next/cache/a\n?? apps/web/.turbo/b\n";
  const service = new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: true,
      agent: { harness: "claude" },
    },
    mergedHost,
    workspace,
    makeAgents(),
  );
  const first = await service.run(false);
  // The merged-PR pass is unaffected by the refusal.
  expect(first[0]?.action).toBe("CLEANED");
  expect(first).toContainEqual({
    action: "AUTO_PULL_REFUSED",
    message: "primary checkout is not clean: apps/web/.next/cache/a, apps/web/.turbo/b",
  });
  // A refusal that fires once and goes quiet is the four-hour silent-stale bug.
  const second = await service.run(false);
  expect(second.filter((result) => result.action === "AUTO_PULL_REFUSED")).toHaveLength(1);
});

test("a pull that throws surfaces as a refusal instead of killing the pass (#91)", async () => {
  class ThrowingPullWorkspace extends CleanupWorkspace {
    override async fastForwardDefaultBranch(): Promise<boolean> {
      throw new Error("fatal: Not possible to fast-forward, aborting.");
    }
  }
  const results = await new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: true,
      agent: { harness: "claude" },
    },
    mergedHost,
    new ThrowingPullWorkspace(),
    makeAgents(),
  ).run(false);
  expect(results[0]?.action).toBe("CLEANED");
  expect(results).toContainEqual({
    action: "AUTO_PULL_REFUSED",
    message: "fatal: Not possible to fast-forward, aborting.",
  });
});

test("a clean primary still fast-forwards when the pass cleaned nothing (#91)", async () => {
  class NoWorktreeWorkspace extends CleanupWorkspace {
    override async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
      return [];
    }
  }
  const workspace = new NoWorktreeWorkspace();
  const results = await new CleanupService(
    {
      defaultBranch: "main",
      workspaceRoot: "/wt",
      harnessOwnedPaths: ["TASK.md", ".claude/"],
      autoPullMain: true,
      agent: { harness: "claude" },
    },
    emptyHost,
    workspace,
    makeAgents(),
  ).run(false);
  expect(results).toEqual([]);
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
      agent: { harness: "claude" },
    },
    mergedHost,
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
    live: WorktreeObservation[] = [mergedWorktree];
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
      agent: { harness: "claude" },
    },
    mergedHost,
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

test("stranded (#64): a detached-HEAD worktree is still reclaimed via its basename identity", async () => {
  const workspace = new StrandedFixtureWorkspace();
  // parseWorktreePorcelain reports a detached worktree with an empty branch;
  // ownership (and therefore capacity) still counts it by basename, so the
  // stranded scan must too or it leaks its slot forever.
  workspace.live = [{ ...strandedWorktree, branch: "" }];
  const service = makeStrandedService(workspace, makeStrandedAgents([]));

  const result = await service.run(false);
  expect(result).toEqual([{ issueNumber: 21, action: "STRANDED_RECLAIMED", dryRun: false }]);
  expect(workspace.removed).toEqual(["/wt/issue-21-fix"]);
  expect(workspace.deletedBranches).toEqual(["issue-21-fix"]);
});

test("stranded (#64): uncommitted work under a live agent is never removed — STRANDED_DIRTY every tick", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.worktreeStatus = " M src/app.ts\n";
  const agents = makeStrandedAgents(["issue-21"]);
  const service = makeStrandedService(workspace, agents);

  await service.run(false); // tick 0: window opens
  await service.run(false); // tick 1: ping
  // Ticks 2+: reclaim window reached, but the live agent's dirty worktree
  // stays loud and untouched — the pre-check never even stops the session.
  for (let tick = 2; tick < 4; tick++) {
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
  expect(agents.stopped).toEqual([]);
  expect(workspace.removed).toEqual([]);
  expect(workspace.deletedBranches).toEqual([]);
});

test("stranded (#64): commits ahead of base under a live agent are never removed — STRANDED_DIRTY every tick", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.ancestor = false;
  const agents = makeStrandedAgents(["issue-21"]);
  const service = makeStrandedService(workspace, agents);

  await service.run(false); // tick 0: window opens
  await service.run(false); // tick 1: ping
  for (let tick = 2; tick < 4; tick++) {
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
  expect(agents.stopped).toEqual([]);
  expect(workspace.removed).toEqual([]);
});

// The session is gone and the worktree holds real work: nobody would ever
// finish it, so the reconcile is a respawn — never a removal, never a
// permanent wedge.
test("stranded (#64): a dead agent leaving real work is respawned in place, not stranded", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.worktreeStatus = " M src/app.ts\n";
  const agents = makeStrandedAgents([]);
  const service = makeStrandedService(workspace, agents);

  const result = await service.run(false);
  expect(result).toEqual([
    {
      issueNumber: 21,
      action: "STRANDED_RESPAWNED",
      dryRun: false,
      message: "worktree contains changes outside the harness allowlist",
    },
  ]);
  expect(agents.started).toHaveLength(1);
  expect(agents.started[0]?.sessionName).toBe("issue-21");
  expect(agents.started[0]?.worktreePath).toBe("/wt/issue-21-fix");
  expect(workspace.removed).toEqual([]);

  // The revived agent is a live session with a restarted silence window: the
  // ladder starts over from the bottom (with staleTicks=1 the window elapses
  // by the next tick, so it pings) — it never re-reclaims or re-respawns.
  expect(await service.run(false)).toEqual([
    { issueNumber: 21, action: "STRANDED_PINGED", dryRun: false },
  ]);
  expect(agents.started).toHaveLength(1);
  expect(workspace.removed).toEqual([]);
});

test("stranded (#64): dry-run plans the respawn and mutates nothing", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.worktreeStatus = " M src/app.ts\n";
  const agents = makeStrandedAgents([]);
  const service = makeStrandedService(workspace, agents);

  const result = await service.run(true);
  expect(result).toEqual([
    {
      issueNumber: 21,
      action: "STRANDED_RESPAWNED",
      dryRun: true,
      message: "worktree contains changes outside the harness allowlist",
    },
  ]);
  expect(agents.started).toEqual([]);
  expect(workspace.removed).toEqual([]);
});

// Boundary audit (INVARIANTS Rule 1): a death between observing the dirt and
// completing the respawn converges — the next tick observes the same
// session-missing + dirty state and retries the respawn.
test("stranded (#64): death before the respawn completes — next tick respawns (RETRIED)", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.worktreeStatus = " M src/app.ts\n";
  const agents = makeStrandedAgents([]);
  let dieOnce = true;
  const realStart = agents.startImplementation.bind(agents);
  agents.startImplementation = async (identity, prompt, agent) => {
    if (dieOnce) {
      dieOnce = false;
      throw new Error("killed before the respawn completed");
    }
    await realStart(identity, prompt, agent);
  };
  const service = makeStrandedService(workspace, agents);

  await expect(service.run(false)).rejects.toThrow("killed before the respawn");
  expect(workspace.removed).toEqual([]);

  const result = await service.run(false);
  expect(result[0]?.action).toBe("STRANDED_RESPAWNED");
  expect(agents.started).toHaveLength(1);
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

test("stranded (#64): a branch with a closed PR is abandoned by verdict — never touched", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.worktreeStatus = " M src/app.ts\n"; // would otherwise respawn
  const agents = makeStrandedAgents([]);
  const withClosedPr: ChangeHost = {
    ...emptyHost,
    async observeClosedOwnedChanges() {
      return [{ number: 98, headRefName: strandedWorktree.branch }];
    },
  };
  const service = makeStrandedService(workspace, agents, withClosedPr);

  expect(await service.run(false)).toEqual([]);
  expect(await service.run(false)).toEqual([]);
  expect(agents.started).toEqual([]);
  expect(agents.pinged).toEqual([]);
  expect(workspace.removed).toEqual([]);
});

// Both runtimes launch a respawn in worktree.path as-is, so a detached
// checkout would leave the new agent committing off-branch forever — that
// state stays loud for operator recovery instead.
test("stranded (#64): a detached worktree with real work is not respawned into — loud, untouched", async () => {
  const workspace = new StrandedFixtureWorkspace();
  workspace.live = [{ ...strandedWorktree, branch: "" }];
  workspace.worktreeStatus = " M src/app.ts\n";
  const agents = makeStrandedAgents([]);
  const service = makeStrandedService(workspace, agents);

  for (let tick = 0; tick < 2; tick++) {
    const result = await service.run(false);
    expect(result).toEqual([
      {
        issueNumber: 21,
        action: "STRANDED_DIRTY",
        dryRun: false,
        message:
          "worktree contains changes outside the harness allowlist; worktree is detached from its branch — operator recovery required",
      },
    ]);
  }
  expect(agents.started).toEqual([]);
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

// A live agent can write between any observation and the forced removal;
// only the post-quiesce re-observation makes the clean-worktree proof real —
// and since our own stop orphaned that last-second work, the agent is
// respawned rather than left dead beside a preserved worktree.
test("stranded (#64): a write racing the reclaim is caught after quiesce — nothing removed, agent respawned", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents(["issue-21"]);
  // The kill succeeds, but the agent's last write landed while stop() was
  // in flight — after the pre-check already saw a clean worktree.
  agents.stop = async (sessionName: string) => {
    agents.stopped.push(sessionName);
    agents.sessions = agents.sessions.filter((candidate) => candidate !== sessionName);
    workspace.worktreeStatus = " M src/app.ts\n";
  };
  const service = makeStrandedService(workspace, agents);

  await service.run(false); // tick 0: window opens
  await service.run(false); // tick 1: ping
  const result = await service.run(false); // tick 2: reclaim attempt
  expect(result).toEqual([
    {
      issueNumber: 21,
      action: "STRANDED_RESPAWNED",
      dryRun: false,
      message: "worktree contains changes outside the harness allowlist",
    },
  ]);
  expect(workspace.removed).toEqual([]);
  expect(agents.started).toHaveLength(1);
  // The revived agent holds a live session and a restarted window: the
  // ladder starts over (with staleTicks=1 the next tick already pings) —
  // nothing is stopped or removed again.
  expect(await service.run(false)).toEqual([
    { issueNumber: 21, action: "STRANDED_PINGED", dryRun: false },
  ]);
  expect(workspace.removed).toEqual([]);
});

test("stranded (#64): a commit racing the reclaim is caught after quiesce — nothing removed, agent respawned", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents(["issue-21"]);
  agents.stop = async (sessionName: string) => {
    agents.stopped.push(sessionName);
    agents.sessions = agents.sessions.filter((candidate) => candidate !== sessionName);
    workspace.live = [{ ...strandedWorktree, headSha: "race-commit" }];
  };
  const service = makeStrandedService(workspace, agents);

  await service.run(false); // tick 0: window opens
  await service.run(false); // tick 1: ping
  const result = await service.run(false); // tick 2: reclaim attempt
  expect(result).toEqual([
    {
      issueNumber: 21,
      action: "STRANDED_RESPAWNED",
      dryRun: false,
      message: "branch has commits not on the base branch",
    },
  ]);
  expect(workspace.removed).toEqual([]);
  expect(agents.started).toHaveLength(1);
});

// TmuxService.stop swallows kill-session failures, so awaiting it proves
// nothing: only an observed-absent session may be reclaimed over.
test("stranded (#64): a session that survives stop blocks the reclaim — nothing removed, retried next tick", async () => {
  const workspace = new StrandedFixtureWorkspace();
  const agents = makeStrandedAgents(["issue-21"]);
  let killWorks = false;
  agents.stop = async (sessionName: string) => {
    agents.stopped.push(sessionName);
    if (killWorks) {
      agents.sessions = agents.sessions.filter((candidate) => candidate !== sessionName);
    }
  };
  const service = makeStrandedService(workspace, agents);

  await service.run(false); // tick 0: window opens
  await service.run(false); // tick 1: ping
  const blocked = await service.run(false); // tick 2: kill silently fails
  expect(blocked).toEqual([
    {
      issueNumber: 21,
      action: "STRANDED_DIRTY",
      dryRun: false,
      message: "agent session survived stop; leaving the worktree untouched",
    },
  ]);
  expect(workspace.removed).toEqual([]);

  killWorks = true;
  const reclaimed = await service.run(false); // tick 3: kill lands, reclaim completes
  expect(reclaimed).toEqual([{ issueNumber: 21, action: "STRANDED_RECLAIMED", dryRun: false }]);
  expect(workspace.removed).toEqual(["/wt/issue-21-fix"]);
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
      agent: { harness: "claude" },
    },
    mergedHost,
    new CleanupWorkspace(),
    agents,
  ).run(false);
  expect(result[0]?.action).toBe("CLEANED");
  expect(agents.stopped).toEqual(["score-demo-issue-1"]);
});
