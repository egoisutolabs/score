import { expect, test } from "vitest";
import type { AgentConfig } from "@/features/config/model";
import type { IssueObservation } from "@/features/dispatch/issue";
import { DispatchService, type DispatchServiceOptions } from "@/features/dispatch/service";
import type { TaskBriefingWriter } from "@/features/dispatch/task-briefing-port";
import type { WorkIdentity, WorktreeObservation } from "@/features/dispatch/work";
import type { WorkSource } from "@/features/dispatch/work-source";
import type { PullRequestObservation } from "@/features/landing/change";
import type { ChangeHost } from "@/features/landing/port";
import type { AgentRuntime } from "@/shared/agent-runtime";
import type { PrimaryCheckoutObservation, WorkspaceDriver } from "@/shared/workspace-driver";

const options: DispatchServiceOptions = {
  workspaceRoot: "/worktrees",
  maxParallelIssues: 2,
  issues: {
    eligibleLabelPrefix: "epic:",
    holdLabel: "hold",
    umbrellaLabel: "umbrella",
  },
  agent: { harness: "claude", model: "opus-4.6" },
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

class FakeWorkspace implements WorkspaceDriver {
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

  async status(): Promise<string> {
    return "";
  }

  async removeWorktree(): Promise<void> {}
  async deleteBranch(): Promise<boolean> {
    return true;
  }

  async observePrimaryCheckout(): Promise<PrimaryCheckoutObservation> {
    return { branch: "main", status: "" };
  }

  async fetchOrigin(): Promise<void> {}
  async stageMerge(): Promise<boolean> {
    return true;
  }
  async abortMerge(): Promise<void> {}
  async commitMerge(): Promise<void> {}
  async pushDefaultBranch(): Promise<void> {}

  async fastForwardDefaultBranch(): Promise<boolean> {
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
