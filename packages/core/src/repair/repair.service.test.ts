import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { createWorkIdentity } from "@score/core/dispatch/dispatch.identity";
import type { WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { PullRequestObservation } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import type { ReviewThreadObservation } from "@score/core/repair/findings/finding.interface";
import { DEFAULT_SESSION_SUFFIX } from "@score/core/repair/repair.policy";
import { RepairService } from "@score/core/repair/repair.service";
import type { RepairHost } from "@score/core/repair/repair-host.interface";
import type { LandingWorkspace, WorktreeProvisioner } from "@score/core/workspace-driver.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";
import { expect, test } from "vitest";

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

class RepairWorkspace
  implements Pick<WorktreeProvisioner, "observeWorktrees">, Pick<LandingWorkspace, "fetchOrigin">
{
  worktrees: WorktreeObservation[] = [];
  async observeWorktrees() {
    return this.worktrees;
  }
  async fetchOrigin() {}
}

class RepairAgents implements AgentRuntime {
  sessions: string[] = [];
  pinged: string[] = [];
  pingedMessages: string[] = [];
  spawned: number[] = [];
  spawnedWith: AgentConfig[] = [];
  async sessionExists() {
    return false;
  }
  async listSessions() {
    return this.sessions;
  }
  async startImplementation() {}
  async ping(sessionName: string, message: string) {
    this.pinged.push(sessionName);
    this.pingedMessages.push(message);
  }
  async startRepair(
    pullRequestNumber: number,
    _worktree: string,
    _message: string,
    agent: AgentConfig,
  ) {
    this.spawned.push(pullRequestNumber);
    this.spawnedWith.push(agent);
  }
  async stop() {}
}

class RecordingHost implements RepairHost {
  calls: string[] = [];
  threads: ReviewThreadObservation[] = [];
  failThreads = false;
  async observeReviewThreads() {
    if (this.failThreads) throw new Error("graphql failed");
    return this.threads;
  }
  comments: string[] = [];
  labels: string[] = [];
  failAt: "comment" | "label" | undefined;
  async addLabel(pullRequestNumber: number, label: string) {
    this.calls.push(`label:${pullRequestNumber}:${label}`);
    if (this.failAt === "label") throw new Error("gh pr edit died");
    this.labels.push(label);
  }
  async hasComment(_pullRequestNumber: number, marker: string) {
    this.calls.push("hasComment");
    return this.comments.some((body) => body.includes(marker));
  }
  async comment(pullRequestNumber: number, body: string) {
    this.calls.push(`comment:${pullRequestNumber}`);
    if (this.failAt === "comment") throw new Error("gh pr comment died");
    this.comments.push(body);
  }
}

function changes(): ChangeHost {
  return {
    async observeOpenChanges() {
      return [change()];
    },
    async observeMergedOwnedChanges() {
      return [];
    },
    async observeClosedOwnedChanges() {
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
  agent: { harness: "claude", model: "opus-4.6" } as AgentConfig,
  sessionSuffix: "-issue-%N",
  includeClean: false,
  onlyPullRequests: new Set<string>(),
  noSpawn: false,
};

test("repair pings the matching live issue session even without a worktree", async () => {
  const workspace = new RepairWorkspace();
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const result = await new RepairService(
    options,
    changes(),
    workspace,
    agents,
    new RecordingHost(),
  ).run();
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
    new RecordingHost(),
  ).run();
  expect(result[0]?.action).toBe("WORKING");
  expect(asked).toEqual([9]);
  expect(agents.pinged).toEqual([]);
});

test("repair spawns shepherd-pr work in the exact existing PR worktree", async () => {
  const workspace = new RepairWorkspace();
  workspace.worktrees = [{ path: "/wt/issue-3-repair", branch: "issue-3-repair", locked: false }];
  const agents = new RepairAgents();
  const result = await new RepairService(
    options,
    changes(),
    workspace,
    agents,
    new RecordingHost(),
  ).run();
  expect(result[0]?.action).toBe("SPAWNED");
  expect(agents.spawned).toEqual([9]);
  // The agent config flows through to the spawn untouched.
  expect(agents.spawnedWith).toEqual([{ harness: "claude", model: "opus-4.6" }]);
});

test("review-thread query failure: shepherd's fail-open zero still decides the ping, but an otherwise clean PR is UNOBSERVED, not clean", async () => {
  const github = new RecordingHost();
  github.failThreads = true;
  const observed: number[] = [];
  const clean = await new RepairService(
    { ...options, onThreads: (number) => void observed.push(number) },
    withChange({ mergeable: "MERGEABLE" }),
    new RepairWorkspace(),
    new RepairAgents(),
    github,
  ).run();
  // Not NOT_NEEDED: that would reset the ledger's budget on a query that saw nothing.
  expect(clean[0]?.action).toBe("UNOBSERVED");
  expect(observed).toEqual([]);

  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const seenDefects: unknown[] = [];
  const conflicting = await new RepairService(
    {
      ...options,
      shouldAct: (_number, defects) => {
        seenDefects.push(defects.unresolvedThreads);
        return true;
      },
    },
    changes(),
    new RepairWorkspace(),
    agents,
    github,
  ).run();
  expect(conflicting[0]?.action).toBe("PINGED");
  expect(seenDefects).toEqual([0]);
});

test("a failed PR list reports onScanFailed and an empty result list, never a scan of nothing", async () => {
  const failures: unknown[] = [];
  const host: ChangeHost = {
    ...changes(),
    async observeRepairChanges() {
      throw new Error("gh pr list died");
    },
  };
  const result = await new RepairService(
    { ...options, onScanFailed: (error) => void failures.push(error) },
    host,
    new RepairWorkspace(),
    new RepairAgents(),
    new RecordingHost(),
  ).run();
  expect(result).toEqual([]);
  expect(failures.map(String)).toEqual(["Error: gh pr list died"]);
});

test("unresolved threads are counted from the observed threads and handed to the ledger first", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const github = new RecordingHost();
  github.threads = [thread("T1", { isResolved: true, resolvedBy: "gendev1" }), thread("T2")];
  const seen: unknown[] = [];
  const result = await new RepairService(
    {
      ...options,
      onThreads: (number, threads) => void seen.push([number, threads.map((t) => t.id)]),
      shouldAct: (_number, defects) => {
        seen.push(defects.unresolvedThreads);
        return true;
      },
    },
    withChange({ mergeable: "MERGEABLE" }),
    new RepairWorkspace(),
    agents,
    github,
  ).run();
  expect(result[0]?.action).toBe("PINGED");
  expect(seen).toEqual([[9, ["T1", "T2"]], 1]);
});

test("a GitHub-clean PR with a landing build-red verdict is repaired, tail in the prompt", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const clean = { ...change(), mergeable: "MERGEABLE" as const };
  const host: ChangeHost = {
    ...changes(),
    async observeOpenChanges() {
      return [clean];
    },
    async observeRepairChanges() {
      return [clean];
    },
  };
  const seenDefects: unknown[] = [];
  const result = await new RepairService(
    {
      ...options,
      buildRed: (pullRequestNumber) =>
        pullRequestNumber === 9 ? "daemon:check — TS2345 boom" : undefined,
      shouldAct: (_number, defects) => {
        seenDefects.push(defects);
        return true;
      },
    },
    host,
    new RepairWorkspace(),
    agents,
    new RecordingHost(),
  ).run();
  expect(result[0]?.action).toBe("PINGED");
  expect(agents.pingedMessages[0]).toContain("daemon:check — TS2345 boom");
  // The verdict rides the defects so the ledger re-pings when the tail changes.
  expect(seenDefects[0]).toMatchObject({ buildRed: "daemon:check — TS2345 boom" });
});

test("default session suffix matches the sessions dispatch creates, and only those", () => {
  const identity = createWorkIdentity("/tmp/worktrees", {
    number: 1,
    title: "Port models",
    body: "",
    labels: [],
    state: "OPEN",
    url: "https://github.com/example/score/issues/1",
    comments: [],
  });
  // Same construction as RepairService: suffix with %N substituted, anchored at the end.
  const pattern = new RegExp(`${DEFAULT_SESSION_SUFFIX.replace("%N", "1")}$`);
  expect(pattern.test(identity.sessionName)).toBe(true);
  expect(pattern.test("my-issue-1")).toBe(false);
  expect(pattern.test("shepherd-pr-1")).toBe(false);
  expect(pattern.test("issue-11")).toBe(false);
});

// Repair gate and round budget (review-loop analysis §2.2).

function withChange(overrides: Partial<PullRequestObservation>): ChangeHost {
  const observed = { ...change(), ...overrides };
  return {
    ...changes(),
    async observeOpenChanges() {
      return [observed];
    },
    async observeRepairChanges() {
      return [observed];
    },
  };
}

test("no ping while a check on the head commit is still running", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const host = withChange({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] });
  const asked: number[] = [];
  const result = await new RepairService(
    {
      ...options,
      shouldAct: (number) => {
        asked.push(number);
        return true;
      },
    },
    host,
    new RepairWorkspace(),
    agents,
    new RecordingHost(),
  ).run();
  expect(result[0]?.action).toBe("CHECKS_PENDING");
  expect(agents.pinged).toEqual([]);
  // The ledger is not even consulted: a pending check is a wait, not a round.
  expect(asked).toEqual([]);
});

test("a clean PR whose checks are still running is CHECKS_PENDING, not clean: the next review is being written", async () => {
  const host = withChange({
    mergeable: "MERGEABLE",
    statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
  });
  const result = await new RepairService(
    options,
    host,
    new RepairWorkspace(),
    new RepairAgents(),
    new RecordingHost(),
  ).run();
  expect(result[0]?.action).toBe("CHECKS_PENDING");
});

test("a completed check that failed still counts as a defect, not a pending wait", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const host = withChange({
    mergeable: "MERGEABLE",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
  });
  const result = await new RepairService(
    options,
    host,
    new RepairWorkspace(),
    agents,
    new RecordingHost(),
  ).run();
  expect(result[0]?.action).toBe("PINGED");
});

const spent = { budget: 2, waves: [], rule: "budget", detail: "2 wave(s) used the budget of 2" };

test("a spent budget posts the history comment, then the label, and pings nobody", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const github = new RecordingHost();
  const result = await new RepairService(
    { ...options, exhaustion: () => spent, shouldAct: () => true },
    changes(),
    new RepairWorkspace(),
    agents,
    github,
  ).run();
  expect(result[0]).toEqual({
    pullRequestNumber: 9,
    action: "EXHAUSTED",
    dryRun: false,
    target: "repair-exhausted",
    parked: { rule: "budget", detail: "2 wave(s) used the budget of 2" },
  });
  expect(github.calls).toEqual(["hasComment", "comment:9", "label:9:repair-exhausted"]);
  expect(github.comments[0]).toContain("<!-- score:repair-exhausted 0@none -->");
  expect(agents.pinged).toEqual([]);
});

test("a second exhaustion after a human removed the label posts its own history comment", async () => {
  const wave = (at: string) => ({
    at,
    tick: 0,
    headSha: "aaa",
    defects: { conflicting: true, unresolvedThreads: 0, failingChecks: 0 },
    openFindings: 0,
    diffSize: undefined,
    promptVersion: "v1",
  });
  const github = new RecordingHost();
  let exhaustion = { ...spent, waves: [wave("T1"), wave("T2")] };
  const service = new RepairService(
    { ...options, exhaustion: () => exhaustion },
    changes(),
    new RepairWorkspace(),
    new RepairAgents(),
    github,
  );
  await service.run();
  expect(github.comments).toHaveLength(1);

  // The label came off, the fresh budget was spent on two new waves: the
  // human needs this history, not the stale one above it.
  exhaustion = { ...spent, waves: [wave("T3"), wave("T4")] };
  github.calls = [];
  await service.run();
  expect(github.calls).toEqual(["hasComment", "comment:9", "label:9:repair-exhausted"]);
  expect(github.comments).toHaveLength(2);
  expect(github.comments[1]).toContain("| 2 | T4 |");
});

test("death after the comment, before the label — next tick labels without a second comment (RETRIED)", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const github = new RecordingHost();
  github.failAt = "label";
  const service = new RepairService(
    { ...options, exhaustion: () => spent },
    changes(),
    new RepairWorkspace(),
    agents,
    github,
  );
  await expect(service.run()).rejects.toThrow("gh pr edit died");
  expect(github.comments).toHaveLength(1);

  github.failAt = undefined;
  github.calls = [];
  const result = await service.run();
  expect(result[0]?.action).toBe("EXHAUSTED");
  expect(github.calls).toEqual(["hasComment", "label:9:repair-exhausted"]);
  expect(github.comments).toHaveLength(1);
  expect(github.labels).toEqual(["repair-exhausted"]);
});

test("death at the comment — next tick comments and labels; nothing was half-done (RETRIED)", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const github = new RecordingHost();
  github.failAt = "comment";
  const service = new RepairService(
    { ...options, exhaustion: () => spent },
    changes(),
    new RepairWorkspace(),
    agents,
    github,
  );
  await expect(service.run()).rejects.toThrow("gh pr comment died");
  expect(github.labels).toEqual([]);

  github.failAt = undefined;
  github.calls = [];
  await service.run();
  expect(github.calls).toEqual(["hasComment", "comment:9", "label:9:repair-exhausted"]);
  expect(github.comments).toHaveLength(1);
  expect(github.labels).toEqual(["repair-exhausted"]);
});

test("a PR already carrying the label is parked: no ping, no mutation, no ledger question", async () => {
  const agents = new RepairAgents();
  agents.sessions = ["score-issue-3"];
  const github = new RecordingHost();
  const asked: string[] = [];
  const result = await new RepairService(
    {
      ...options,
      exhaustion: () => {
        asked.push("exhaustion");
        return undefined;
      },
      shouldAct: () => {
        asked.push("shouldAct");
        return true;
      },
    },
    withChange({ labels: [{ name: "repair-exhausted" }] }),
    new RepairWorkspace(),
    agents,
    github,
  ).run();
  expect(result[0]?.action).toBe("EXHAUSTED");
  expect(agents.pinged).toEqual([]);
  expect(github.calls).toEqual([]);
  expect(asked).toEqual([]);
});

test("a dry run reports EXHAUSTED without commenting or labeling", async () => {
  const github = new RecordingHost();
  const result = await new RepairService(
    { ...options, exhaustion: () => spent },
    changes(),
    new RepairWorkspace(),
    new RepairAgents(),
    github,
  ).run(true);
  expect(result[0]?.action).toBe("EXHAUSTED");
  expect(github.calls).toEqual([]);
});

function thread(
  id: string,
  overrides: Partial<ReviewThreadObservation> = {},
): ReviewThreadObservation {
  return {
    id,
    path: "src/a.ts",
    originalLine: 1,
    originalCommit: "rev",
    author: "chatgpt-codex-connector",
    createdAt: "2026-10-16T00:00:00Z",
    isResolved: false,
    resolvedBy: undefined,
    ...overrides,
  };
}
