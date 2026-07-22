import { expect, test } from "vitest";
import type { WorkIdentity, WorktreeObservation } from "@/features/dispatch/work";
import type { PullRequestObservation } from "@/features/landing/change";
import type { ChangeHost } from "@/features/landing/port";
import { LandingService } from "@/features/landing/service";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";
import type { PrimaryCheckoutObservation, WorkspaceDriver } from "@/shared/workspace-driver";

function pullRequest(overrides: Partial<PullRequestObservation> = {}): PullRequestObservation {
  return {
    number: 7,
    title: "Legacy landing",
    headRefName: "issue-1-legacy-landing",
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
  async stageMerge(): Promise<boolean> {
    this.effects.push("stage");
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
  expect(workspace.effects).toEqual([
    "fetch",
    "fetch",
    "stage",
    "abort",
    "fetch",
    "fetch",
    "stage",
    "commit",
    "push",
  ]);
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
