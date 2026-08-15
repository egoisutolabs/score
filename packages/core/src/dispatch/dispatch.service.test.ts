import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import {
  DispatchService,
  type DispatchServiceOptions,
} from "@score/core/dispatch/dispatch.service";
import type { TaskBriefingWriter } from "@score/core/dispatch/task-briefing.interface";
import type { WorkIdentity, WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { WorkSource } from "@score/core/dispatch/work-source.interface";
import type { PullRequestObservation } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { WorktreeProvisioner } from "@score/core/workspace-driver.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";
import { expect, test } from "vitest";
import type { IssueObservation } from "./issue.interface";

const options: DispatchServiceOptions = {
  workspaceRoot: "/worktrees",
  maxParallelIssues: 2,
  issues: {
    eligibleLabelPrefix: "epic:",
    holdLabel: "hold",
    umbrellaLabel: "umbrella",
  },
  agent: { harness: "claude", model: "opus-4.6" },
  dispatchableHarnesses: ["claude"],
};

function issue(number: number): IssueObservation {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    labels: [{ name: "epic:v0" }],
    state: "OPEN",
    url: `https://github.com/example/score/issues/${number}`,
    comments: [],
  };
}

class FakeWorkSource implements WorkSource {
  readonly details = new Map([
    [1, issue(1)],
    [2, issue(2)],
  ]);

  async observeIssues(): Promise<readonly IssueObservation[]> {
    return [this.#requiredIssue(2), this.#requiredIssue(1)];
  }

  async observeIssue(issueNumber: number): Promise<IssueObservation> {
    return this.#requiredIssue(issueNumber);
  }

  async observeDependency(issueNumber: number) {
    const observed = this.#requiredIssue(issueNumber);
    return { number: observed.number, state: observed.state, stateReason: observed.stateReason };
  }

  #requiredIssue(issueNumber: number): IssueObservation {
    const observed = this.details.get(issueNumber);
    if (!observed) throw new Error(`unknown issue ${issueNumber}`);
    return observed;
  }
}

class FakeWorkspace implements WorktreeProvisioner {
  readonly worktrees: WorktreeObservation[] = [];
  readonly created: number[] = [];

  async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
    return this.worktrees;
  }

  async createWorktree(identity: WorkIdentity): Promise<void> {
    if (identity.issueNumber === 1) throw new Error("injected create failure");
    this.created.push(identity.issueNumber);
    this.worktrees.push({ path: identity.worktreePath, branch: identity.branch, locked: false });
  }

  async isAncestor(): Promise<boolean> {
    return true;
  }

  async status(): Promise<string> {
    return "";
  }

  async removeWorktree(_worktree: WorktreeObservation): Promise<void> {}
  async deleteBranch(): Promise<boolean> {
    return true;
  }
}

class FakeAgents implements AgentRuntime {
  readonly started: number[] = [];
  readonly launches: { sessionName: string; agent: AgentConfig }[] = [];
  sessions: string[] = [];

  async sessionExists(sessionName: string): Promise<boolean> {
    return this.sessions.includes(sessionName);
  }

  async listSessions(): Promise<readonly string[]> {
    return this.sessions;
  }

  async startImplementation(
    identity: WorkIdentity,
    _prompt: string,
    agent: AgentConfig,
  ): Promise<void> {
    this.started.push(identity.issueNumber);
    this.launches.push({ sessionName: identity.sessionName, agent });
  }

  async ping(): Promise<void> {}
  async startRepair(): Promise<void> {}
  async stop(): Promise<void> {}
}

const changes: ChangeHost = {
  async observeOpenChanges(): Promise<readonly PullRequestObservation[]> {
    return [];
  },
  async observeMergedOwnedChanges(): Promise<readonly PullRequestObservation[]> {
    return [];
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
  async unresolvedThreadCount(): Promise<number> {
    return 0;
  },
};

test("a zero-slot tick with eligible candidates reports the capacity decision instead of exiting silently (#65)", async () => {
  const workspace = new FakeWorkspace();
  workspace.worktrees.push(
    { path: "/worktrees/issue-21-stale-holder", branch: "issue-21-stale-holder", locked: false },
    { path: "/worktrees/issue-34-live-holder", branch: "issue-34-live-holder", locked: false },
  );
  const agents = new FakeAgents();
  const service = new DispatchService(options, new FakeWorkSource(), changes, workspace, agents, {
    async write(): Promise<void> {
      throw new Error("a zero-slot tick must not write TASK.md");
    },
  });

  const result = await service.run();

  expect(result.started).toEqual([]);
  expect(result.planned).toEqual([]);
  expect(result.blocked).toEqual([]);
  expect(result.failed).toEqual([]);
  expect(result.capacity).toEqual({
    active: 2,
    max: 2,
    heldBy: ["issue-21-stale-holder", "issue-34-live-holder"],
    starved: true,
  });
  expect(workspace.created).toEqual([]);
  expect(agents.started).toEqual([]);
});

test("a zero-slot tick with no eligible candidates reports capacity without starving (#65)", async () => {
  const workspace = new FakeWorkspace();
  workspace.worktrees.push({
    path: "/worktrees/issue-21-stale-holder",
    branch: "issue-21-stale-holder",
    locked: false,
  });
  const heldIssuesOnly: WorkSource = {
    async observeIssues() {
      // Eligibility filtering happens before any in-flight check, so these
      // never count as waiting candidates.
      return [{ ...issue(7), labels: [{ name: "hold" }] }];
    },
    async observeIssue() {
      return issue(7);
    },
    async observeDependency() {
      return issue(7);
    },
  };
  const service = new DispatchService(
    { ...options, maxParallelIssues: 1 },
    heldIssuesOnly,
    changes,
    workspace,
    new FakeAgents(),
    { async write(): Promise<void> {} },
  );

  const result = await service.run();

  expect(result.capacity).toEqual({
    active: 1,
    max: 1,
    heldBy: ["issue-21-stale-holder"],
    starved: false,
  });
});

test("at capacity with only in-flight candidates is a healthy tick, not starvation (#65)", async () => {
  const workspace = new FakeWorkspace();
  workspace.worktrees.push(
    { path: "/worktrees/issue-21-live-holder", branch: "issue-21-live-holder", locked: false },
    { path: "/worktrees/issue-34-live-holder", branch: "issue-34-live-holder", locked: false },
  );
  // The slot holders themselves are open, labeled issues — observeIssues()
  // still returns them, but #alreadyInFlight would block every one.
  const holdersOnly: WorkSource = {
    async observeIssues() {
      return [issue(34), issue(21)];
    },
    async observeIssue(issueNumber: number) {
      return issue(issueNumber);
    },
    async observeDependency(issueNumber: number) {
      return issue(issueNumber);
    },
  };
  const service = new DispatchService(options, holdersOnly, changes, workspace, new FakeAgents(), {
    async write(): Promise<void> {},
  });

  const result = await service.run();

  expect(result.capacity).toEqual({
    active: 2,
    max: 2,
    heldBy: ["issue-21-live-holder", "issue-34-live-holder"],
    starved: false,
  });
});

test("at capacity with only dependency-incomplete candidates is not starvation (#65)", async () => {
  const workspace = new FakeWorkspace();
  workspace.worktrees.push({
    path: "/worktrees/issue-21-live-holder",
    branch: "issue-21-live-holder",
    locked: false,
  });
  const waitingOnAnOpenDependency: WorkSource = {
    async observeIssues() {
      return [{ ...issue(9), body: "## Dependencies\n- #1\n" }];
    },
    async observeIssue() {
      return { ...issue(9), body: "## Dependencies\n- #1\n" };
    },
    async observeDependency() {
      // Issue 1 is OPEN — dependency incomplete, so a free slot would not
      // start this candidate either.
      return issue(1);
    },
  };
  const service = new DispatchService(
    { ...options, maxParallelIssues: 1 },
    waitingOnAnOpenDependency,
    changes,
    workspace,
    new FakeAgents(),
    { async write(): Promise<void> {} },
  );

  const result = await service.run();

  expect(result.capacity).toEqual({
    active: 1,
    max: 1,
    heldBy: ["issue-21-live-holder"],
    starved: false,
  });
});

test("the detached holder's own issue is not a waiting candidate (#65)", async () => {
  const workspace = new FakeWorkspace();
  workspace.worktrees.push({
    path: "/worktrees/issue-21-detached-slug",
    branch: "",
    locked: false,
  });
  // The holder's issue stays open and labeled while its agent runs; only the
  // worktree-identity fallback can recognize it as the slot's own issue.
  const holderOnly: WorkSource = {
    async observeIssues() {
      return [issue(21)];
    },
    async observeIssue() {
      return issue(21);
    },
    async observeDependency() {
      return issue(21);
    },
  };
  const service = new DispatchService(
    { ...options, maxParallelIssues: 1 },
    holderOnly,
    changes,
    workspace,
    new FakeAgents(),
    { async write(): Promise<void> {} },
  );

  const result = await service.run();

  expect(result.capacity).toEqual({
    active: 1,
    max: 1,
    heldBy: ["issue-21-detached-slug"],
    starved: false,
  });
});

test("a detached-HEAD worktree still marks its own issue in flight for a slotted run (#65)", async () => {
  const workspace = new FakeWorkspace();
  workspace.worktrees.push({
    path: "/worktrees/issue-21-detached-slug",
    branch: "",
    locked: false,
  });
  const holderOnly: WorkSource = {
    async observeIssues() {
      return [issue(21)];
    },
    async observeIssue() {
      return issue(21);
    },
    async observeDependency() {
      return issue(21);
    },
  };
  const service = new DispatchService(
    { ...options, maxParallelIssues: 2 },
    holderOnly,
    changes,
    workspace,
    new FakeAgents(),
    { async write(): Promise<void> {} },
  );

  const result = await service.run();

  expect(result.blocked).toEqual([{ issueNumber: 21, reasons: ["ALREADY_IN_FLIGHT"] }]);
  expect(result.started).toEqual([]);
  expect(workspace.created).toEqual([]);
});

test("the starvation scan observes global in-flight state once per tick, not per candidate (#65)", async () => {
  let worktreeObservations = 0;
  let changeHeadCalls = 0;
  let sessionProbes = 0;
  class CountingWorkspace extends FakeWorkspace {
    override async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
      worktreeObservations += 1;
      return super.observeWorktrees();
    }
  }
  class CountingAgents extends FakeAgents {
    override async sessionExists(sessionName: string): Promise<boolean> {
      sessionProbes += 1;
      return super.sessionExists(sessionName);
    }
  }
  const workspace = new CountingWorkspace();
  workspace.worktrees.push(
    { path: "/worktrees/issue-1-live", branch: "issue-1-live", locked: false },
    { path: "/worktrees/issue-2-live", branch: "issue-2-live", locked: false },
  );
  const agents = new CountingAgents();
  agents.sessions = ["issue-5"];
  const source: WorkSource = {
    async observeIssues() {
      return [issue(3), issue(4), issue(5)];
    },
    async observeIssue(issueNumber: number) {
      return issue(issueNumber);
    },
    async observeDependency(issueNumber: number) {
      return issue(issueNumber);
    },
  };
  const countingChanges: ChangeHost = {
    ...changes,
    async observeOpenChangeHeads() {
      changeHeadCalls += 1;
      return [
        { number: 103, headRefName: "issue-3-pr-branch" },
        { number: 104, headRefName: "issue-4-pr-branch" },
      ];
    },
  };
  const service = new DispatchService(options, source, countingChanges, workspace, agents, {
    async write(): Promise<void> {},
  });

  const result = await service.run();

  expect(result.capacity.starved).toBe(false);
  // One observation of each global witness set per tick — not one per candidate.
  expect(worktreeObservations).toBe(1);
  expect(changeHeadCalls).toBe(1);
  // Sessions stay targeted per-candidate probes (listSessions is lossy for
  // un-namespaced opencode and swallows tmux failures); only candidates the
  // snapshots cannot witness reach the probe.
  expect(sessionProbes).toBe(1);
});

test("a detached-HEAD slot holder is named by its worktree identity, not an empty branch (#65)", async () => {
  const workspace = new FakeWorkspace();
  workspace.worktrees.push({
    path: "/worktrees/issue-21-detached-slug",
    branch: "",
    locked: false,
  });
  const service = new DispatchService(
    { ...options, maxParallelIssues: 1 },
    new FakeWorkSource(),
    changes,
    workspace,
    new FakeAgents(),
    { async write(): Promise<void> {} },
  );

  const result = await service.run();

  expect(result.capacity.heldBy).toEqual(["issue-21-detached-slug"]);
  expect(result.capacity.starved).toBe(true);
});

test("capacity reports the tick's entry observation, not post-run state (#65)", async () => {
  // FakeWorkspace's base injects a create failure for issue 1; this run must
  // start cleanly to isolate the capacity semantics.
  class PlainWorkspace extends FakeWorkspace {
    override async createWorktree(identity: WorkIdentity): Promise<void> {
      this.created.push(identity.issueNumber);
      this.worktrees.push({ path: identity.worktreePath, branch: identity.branch, locked: false });
    }
  }
  const workspace = new PlainWorkspace();
  workspace.worktrees.push({
    path: "/worktrees/issue-5-already-running",
    branch: "issue-5-already-running",
    locked: false,
  });
  const service = new DispatchService(
    options,
    new FakeWorkSource(),
    changes,
    workspace,
    new FakeAgents(),
    { async write(): Promise<void> {} },
  );

  const result = await service.run();

  expect(result.started).toEqual([1]);
  expect(result.capacity).toEqual({
    active: 1,
    max: 2,
    heldBy: ["issue-5-already-running"],
    starved: false,
  });
});

test("a failed task preparation does not suppress the next deterministic candidate", async () => {
  const workspace = new FakeWorkspace();
  const agents = new FakeAgents();
  const written: number[] = [];
  const briefings: TaskBriefingWriter = {
    async write(observedIssue): Promise<void> {
      written.push(observedIssue.number);
    },
  };
  const service = new DispatchService(
    options,
    new FakeWorkSource(),
    changes,
    workspace,
    agents,
    briefings,
  );

  const result = await service.run();

  expect(result.failed).toEqual([{ issueNumber: 1, message: "injected create failure" }]);
  expect(result.started).toEqual([2]);
  expect(workspace.created).toEqual([2]);
  expect(written).toEqual([2]);
  expect(agents.started).toEqual([2]);
  // The configured agent reaches the launch untouched — the model pin is wired.
  expect(agents.launches).toEqual([
    { sessionName: "issue-2", agent: { harness: "claude", model: "opus-4.6" } },
  ]);
});

test("a namespaced dispatch launches namespaced sessions and finds them in flight", async () => {
  const namespaced = { ...options, maxParallelIssues: 1, namespace: "demo" };
  const first = new FakeAgents();
  const firstRun = new DispatchService(
    namespaced,
    new FakeWorkSource(),
    changes,
    new FakeWorkspace(),
    first,
    { async write(): Promise<void> {} },
  );
  expect((await firstRun.run()).started).toEqual([2]);
  expect(first.launches[0]?.sessionName).toBe("score-demo-issue-2");

  // A live namespaced session is an in-flight witness for the same issue.
  const second = new FakeAgents();
  second.sessions = ["score-demo-issue-2"];
  const secondRun = new DispatchService(
    namespaced,
    new FakeWorkSource(),
    changes,
    new FakeWorkspace(),
    second,
    { async write(): Promise<void> {} },
  );
  const result = await secondRun.run();
  expect(result.blocked).toContainEqual({ issueNumber: 2, reasons: ["ALREADY_IN_FLIGHT"] });
  expect(second.started).toEqual([]);
});

test("successful preparation preserves create, briefing, then launch order", async () => {
  const events: string[] = [];
  class OrderedWorkspace extends FakeWorkspace {
    override async createWorktree(identity: WorkIdentity): Promise<void> {
      events.push("create-worktree");
      await super.createWorktree(identity);
    }
  }
  class OrderedAgents extends FakeAgents {
    override async startImplementation(
      identity: WorkIdentity,
      prompt: string,
      agent: AgentConfig,
    ): Promise<void> {
      events.push("launch-session");
      await super.startImplementation(identity, prompt, agent);
    }
  }
  const workspace = new OrderedWorkspace();
  const agents = new OrderedAgents();
  const source: WorkSource = {
    async observeIssues() {
      return [issue(2)];
    },
    async observeIssue() {
      return issue(2);
    },
    async observeDependency() {
      return issue(2);
    },
  };
  const service = new DispatchService(
    { ...options, maxParallelIssues: 1 },
    source,
    changes,
    workspace,
    agents,
    {
      async write(): Promise<void> {
        events.push("write-task");
      },
    },
  );

  expect((await service.run()).started).toEqual([2]);
  expect(events).toEqual(["create-worktree", "write-task", "launch-session"]);
});

test("dry-run plans only available capacity and performs no mutations", async () => {
  const oneSlot = { ...options, maxParallelIssues: 1 };
  const workspace = new FakeWorkspace();
  const agents = new FakeAgents();
  const service = new DispatchService(oneSlot, new FakeWorkSource(), changes, workspace, agents, {
    async write(): Promise<void> {
      throw new Error("dry-run must not write TASK.md");
    },
  });

  const result = await service.run({ dryRun: true });

  expect(result.planned).toEqual([1]);
  expect(result.blocked).toEqual([]);
  expect(workspace.created).toEqual([]);
  expect(agents.started).toEqual([]);
});

test("an undispatchable harness fails without creating a worktree, and the issue is retried next tick", async () => {
  const opencodeOptions: DispatchServiceOptions = {
    ...options,
    maxParallelIssues: 1,
    agent: { harness: "opencode", model: "openai/gpt-5" },
  };
  const source: WorkSource = {
    async observeIssues() {
      return [issue(2)];
    },
    async observeIssue() {
      return issue(2);
    },
    async observeDependency() {
      return issue(2);
    },
  };

  const workspace = new FakeWorkspace();
  const agents = new FakeAgents();
  const service = new DispatchService(opencodeOptions, source, changes, workspace, agents, {
    async write(): Promise<void> {},
  });

  const first = await service.run();
  expect(first.failed).toEqual([{ issueNumber: 2, message: 'unknown agent harness: "opencode"' }]);
  expect(first.started).toEqual([]);
  expect(workspace.created).toEqual([]);
  expect(agents.started).toEqual([]);

  // No worktree, session, or open change survived — the next tick attempts the issue again.
  const second = await service.run();
  expect(second.blocked).toEqual([]);
  expect(second.failed).toEqual([{ issueNumber: 2, message: 'unknown agent harness: "opencode"' }]);
});

test("a dry-run preview reports an undispatchable harness as a failure, not a plan", async () => {
  const opencodeOptions: DispatchServiceOptions = {
    ...options,
    maxParallelIssues: 1,
    agent: { harness: "opencode", model: "openai/gpt-5" },
  };
  const source: WorkSource = {
    async observeIssues() {
      return [issue(2)];
    },
    async observeIssue() {
      return issue(2);
    },
    async observeDependency() {
      return issue(2);
    },
  };

  const workspace = new FakeWorkspace();
  const agents = new FakeAgents();
  const service = new DispatchService(opencodeOptions, source, changes, workspace, agents, {
    async write(): Promise<void> {
      throw new Error("dry-run must not write TASK.md");
    },
  });

  const result = await service.run({ dryRun: true });

  expect(result.failed).toEqual([{ issueNumber: 2, message: 'unknown agent harness: "opencode"' }]);
  expect(result.planned).toEqual([]);
  expect(workspace.created).toEqual([]);
});

test("dispatchability is whatever the composition root injects, not a hardcoded runtime assumption", async () => {
  // Simulates a future composition root wiring a harness-capable AgentRuntime (e.g. OpencodeService)
  // for "opencode" — DispatchService must not reject it on its own authority.
  const opencodeCapableOptions: DispatchServiceOptions = {
    ...options,
    maxParallelIssues: 1,
    agent: { harness: "opencode", model: "openai/gpt-5" },
    dispatchableHarnesses: ["claude", "opencode"],
  };
  const source: WorkSource = {
    async observeIssues() {
      return [issue(2)];
    },
    async observeIssue() {
      return issue(2);
    },
    async observeDependency() {
      return issue(2);
    },
  };

  const workspace = new FakeWorkspace();
  const agents = new FakeAgents();
  const service = new DispatchService(opencodeCapableOptions, source, changes, workspace, agents, {
    async write(): Promise<void> {},
  });

  const result = await service.run();
  expect(result.failed).toEqual([]);
  expect(result.started).toEqual([2]);
  expect(workspace.created).toEqual([2]);
  expect(agents.launches).toEqual([
    { sessionName: "issue-2", agent: { harness: "opencode", model: "openai/gpt-5" } },
  ]);
});

test("an older slug for the same issue number is still an in-flight witness", async () => {
  const workspace = new FakeWorkspace();
  const agents = new FakeAgents();
  const oldSlugChanges: ChangeHost = {
    ...changes,
    async observeOpenChangeHeads() {
      return [
        {
          number: 20,
          headRefName: "issue-1-title-before-edit",
        },
      ];
    },
  };
  const service = new DispatchService(
    { ...options, maxParallelIssues: 1 },
    {
      async observeIssues() {
        return [issue(1)];
      },
      async observeIssue() {
        return issue(1);
      },
      async observeDependency() {
        return issue(1);
      },
    },
    oldSlugChanges,
    workspace,
    agents,
    { async write(): Promise<void> {} },
  );

  const result = await service.run();

  expect(result.blocked).toEqual([{ issueNumber: 1, reasons: ["ALREADY_IN_FLIGHT"] }]);
  expect(result.started).toEqual([]);
});

test("mutation-time refresh does not invent a second eligibility-label gate", async () => {
  const workspace = new FakeWorkspace();
  const agents = new FakeAgents();
  const source: WorkSource = {
    async observeIssues() {
      return [issue(2)];
    },
    async observeIssue() {
      return { ...issue(2), labels: [] };
    },
    async observeDependency() {
      return issue(2);
    },
  };
  const service = new DispatchService(options, source, changes, workspace, agents, {
    async write(): Promise<void> {},
  });

  expect((await service.run()).started).toEqual([2]);
});

test("a mid-start failure rolls back the created worktree so the next tick retries (#32)", async () => {
  const removed: WorktreeObservation[] = [];
  class RollbackWorkspace extends FakeWorkspace {
    override async removeWorktree(worktree: WorktreeObservation): Promise<void> {
      removed.push(worktree);
      const index = this.worktrees.findIndex((candidate) => candidate.path === worktree.path);
      if (index >= 0) this.worktrees.splice(index, 1);
    }
  }
  class DiesBeforeBriefAgents extends FakeAgents {
    failuresLeft = 1;
    override async startImplementation(
      identity: WorkIdentity,
      prompt: string,
      agent: AgentConfig,
    ): Promise<void> {
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        throw new Error("child died before the brief was delivered");
      }
      await super.startImplementation(identity, prompt, agent);
    }
  }
  const workspace = new RollbackWorkspace();
  const agents = new DiesBeforeBriefAgents();
  const source: WorkSource = {
    async observeIssues() {
      return [issue(2)];
    },
    async observeIssue() {
      return issue(2);
    },
    async observeDependency() {
      return issue(2);
    },
  };
  const service = new DispatchService(options, source, changes, workspace, agents, {
    async write(): Promise<void> {},
  });

  const first = await service.run();
  expect(first.failed).toEqual([
    { issueNumber: 2, message: "child died before the brief was delivered" },
  ]);
  expect(removed).toHaveLength(1);
  expect(removed[0]?.branch.startsWith("issue-2-")).toBe(true);
  expect(workspace.worktrees).toEqual([]);

  // With the leftover reclaimed, the same pass shape dispatches the issue cleanly.
  const second = await service.run();
  expect(second.started).toEqual([2]);
  expect(agents.started).toEqual([2]);
});
