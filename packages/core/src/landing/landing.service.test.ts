import type { WorkIdentity, WorktreeObservation } from "@score/core/dispatch/work.interface";
import type { PullRequestObservation } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import { LandingService } from "@score/core/landing/landing.service";
import type {
  PrimaryCheckoutObservation,
  WorkspaceDriver,
} from "@score/core/workspace-driver.interface";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import { expect, test } from "vitest";

function pullRequest(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    number: 7,
    title: "Legacy landing",
    headRefName: "issue-1-legacy-landing",
    headSha: "aaa111",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    labels: [],
    files: [],
    statusCheckRollup: [],
    ...overrides,
  };
}

class FakeWorkspace implements WorkspaceDriver {
  readonly effects: string[] = [];
  checkout: PrimaryCheckoutObservation = { branch: "main", status: "" };

  async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
    return [];
  }
  async createWorktree(_identity: WorkIdentity): Promise<void> {}
  async status(): Promise<string> {
    return "";
  }
  async removeWorktree(): Promise<void> {}
  async deleteBranch(): Promise<boolean> {
    return true;
  }
  async observePrimaryCheckout(): Promise<PrimaryCheckoutObservation> {
    return this.checkout;
  }
  async fetchOrigin(): Promise<void> {
    this.effects.push("fetch");
  }
  async stageMerge(commit: string): Promise<boolean> {
    this.effects.push(`stage:${commit}`);
    return true;
  }
  async abortMerge(): Promise<void> {
    this.effects.push("abort");
  }
  async commitMerge(): Promise<void> {
    this.effects.push("commit");
  }
  async pushDefaultBranch(): Promise<void> {
    this.effects.push("push");
  }
  async fastForwardDefaultBranch(): Promise<boolean> {
    return true;
  }
}

const runner: CommandRunner = {
  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    return {
      command,
      cwd: options.cwd,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  },
};

function host(change = pullRequest()): ChangeHost {
  return {
    async observeOpenChanges() {
      return [change];
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
}

test("landing re-stages and gates until soakTicks consecutive green ticks, then commits and pushes", async () => {
  const workspace = new FakeWorkspace();
  const service = new LandingService(
    {
      repositoryRoot: "/repo",
      repository: "owner/repo",
      defaultBranch: "main",
      dryRun: false,
      noMerge: false,
      maxMerges: 5,
      soakTicks: 2,
      skipLabels: ["hold", "wip", "do-not-merge"],
      onlyIssueBranches: false,
    },
    host(),
    workspace,
    runner,
  );

  expect((await service.runTick())[0]?.tag).toBe("soaking");
  expect((await service.runTick())[0]?.tag).toBe("merged");
  // Staging targets the observed SHA, never the mutable branch name.
  expect(workspace.effects).toEqual([
    "fetch",
    "fetch",
    "stage:aaa111",
    "abort",
    "fetch",
    "fetch",
    "stage:aaa111",
    "commit",
    "push",
  ]);
});

test("a new head mid-soak restarts soak from zero instead of inheriting green ticks", async () => {
  let change = pullRequest({ headSha: "aaa111" });
  const changes: ChangeHost = {
    ...host(),
    async observeOpenChanges() {
      return [change];
    },
  };
  const workspace = new FakeWorkspace();
  const service = new LandingService(
    {
      repositoryRoot: "/repo",
      repository: "owner/repo",
      defaultBranch: "main",
      dryRun: false,
      noMerge: false,
      maxMerges: 5,
      soakTicks: 2,
      skipLabels: [],
      onlyIssueBranches: false,
    },
    changes,
    workspace,
    runner,
  );

  // Head A soaks its first green tick...
  expect((await service.runTick())[0]?.tag).toBe("soaking");
  // ...the agent pushes head B. Under number-only soak, B would inherit A's
  // tick and merge here with a single green evaluation.
  change = pullRequest({ headSha: "bbb222" });
  expect((await service.runTick())[0]?.tag).toBe("soaking");
  expect((await service.runTick())[0]?.tag).toBe("merged");
  // Every stage after the push targeted B's exact commit.
  expect(workspace.effects.filter((e) => e.startsWith("stage:"))).toEqual([
    "stage:aaa111",
    "stage:bbb222",
    "stage:bbb222",
  ]);
});

test("an observation without a head SHA is refused before any merge effect", async () => {
  const workspace = new FakeWorkspace();
  const service = new LandingService(
    {
      repositoryRoot: "/repo",
      repository: "owner/repo",
      defaultBranch: "main",
      dryRun: false,
      noMerge: false,
      maxMerges: 5,
      soakTicks: 2,
      skipLabels: [],
      onlyIssueBranches: false,
    },
    host(pullRequest({ headSha: undefined })),
    workspace,
    runner,
  );
  const [result] = await service.runTick();
  expect(result?.tag).toBe("skipped");
  expect(result?.note).toContain("no head SHA");
  expect(workspace.effects.some((e) => e.startsWith("stage:"))).toBe(false);
});

test("a lapse resets the green-tick counter, so soaking restarts from zero", async () => {
  let change = pullRequest();
  const changes: ChangeHost = {
    ...host(),
    async observeOpenChanges() {
      return [change];
    },
  };
  const service = new LandingService(
    {
      repositoryRoot: "/repo",
      repository: "owner/repo",
      defaultBranch: "main",
      dryRun: false,
      noMerge: false,
      maxMerges: 5,
      soakTicks: 2,
      skipLabels: [],
      onlyIssueBranches: false,
    },
    changes,
    new FakeWorkspace(),
    runner,
  );

  expect((await service.runTick())[0]?.tag).toBe("soaking");
  change = pullRequest({ mergeable: "CONFLICTING" });
  expect((await service.runTick())[0]?.tag).toBe("conflict");
  change = pullRequest();
  expect((await service.runTick())[0]?.tag).toBe("soaking");
  expect((await service.runTick())[0]?.tag).toBe("merged");
});

test("dirty main skips the PR before host checks or merge effects", async () => {
  const workspace = new FakeWorkspace();
  workspace.checkout = { branch: "main", status: " M src/app.ts\n" };
  let threadCalls = 0;
  const changes: ChangeHost = {
    async observeOpenChanges() {
      return [pullRequest()];
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
      threadCalls += 1;
      return 0;
    },
  };
  const service = new LandingService(
    {
      repositoryRoot: "/repo",
      repository: "owner/repo",
      defaultBranch: "main",
      dryRun: false,
      noMerge: false,
      maxMerges: 5,
      soakTicks: 2,
      skipLabels: [],
      onlyIssueBranches: false,
    },
    changes,
    workspace,
    runner,
  );
  expect((await service.runTick())[0]?.tag).toBe("skipped");
  expect(threadCalls).toBe(0);
  expect(workspace.effects).toEqual(["fetch"]);
});

test("a cheap conflict blocker wins before the review-thread query", async () => {
  const workspace = new FakeWorkspace();
  const conflicting = pullRequest({ mergeable: "CONFLICTING" });
  const changes: ChangeHost = {
    async observeOpenChanges() {
      return [conflicting];
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
      throw new Error("must not be queried");
    },
  };
  const service = new LandingService(
    {
      repositoryRoot: "/repo",
      repository: "owner/repo",
      defaultBranch: "main",
      dryRun: false,
      noMerge: false,
      maxMerges: 5,
      soakTicks: 2,
      skipLabels: [],
      onlyIssueBranches: false,
    },
    changes,
    workspace,
    runner,
  );
  expect((await service.runTick())[0]?.tag).toBe("conflict");
});
