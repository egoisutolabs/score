import type { PullRequestObservation } from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import { LandingService } from "@score/core/landing/landing.service";
import type {
  LandingWorkspace,
  PrimaryCheckoutObservation,
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

class FakeWorkspace implements LandingWorkspace {
  readonly effects: string[] = [];
  checkout: PrimaryCheckoutObservation = { branch: "main", status: "" };

  async observePrimaryCheckout(): Promise<PrimaryCheckoutObservation> {
    return this.checkout;
  }
  async fetchOrigin(): Promise<void> {
    this.effects.push("fetch");
  }
  async sweepStageResidue(): Promise<readonly string[]> {
    this.effects.push("sweep");
    return [];
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
    "sweep",
    "fetch",
    "stage:aaa111",
    "abort",
    "fetch",
    "sweep",
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
  expect(workspace.effects).toEqual(["fetch", "sweep"]);
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

test("a failed review-thread observation skips the PR instead of assuming zero threads", async () => {
  const changes: ChangeHost = {
    ...host(),
    async unresolvedThreadCount(): Promise<number> {
      throw new Error("pagination failed");
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
  const [result] = await service.runTick();
  expect(result?.tag).toBe("skipped");
  expect(result?.note).toContain("review-thread observation failed");
  expect(workspace.effects.some((e) => e.startsWith("stage:"))).toBe(false);
});

test("a failed push halts the remaining landing candidates for that tick (D1)", async () => {
  // Landing otherwise continues to the next candidate, and a second merge
  // committed on top of the unpushed first builds a local-only chain that
  // D1 recovery deliberately refuses (its head's first parent is not an
  // ancestor of origin) — so the halt is what keeps the wedge recoverable.
  class FailingPushWorkspace extends FakeWorkspace {
    override async pushDefaultBranch(): Promise<void> {
      this.effects.push("push");
      throw new Error("origin unreachable");
    }
  }
  const changes: ChangeHost = {
    ...host(),
    async observeOpenChanges() {
      return [
        pullRequest({ number: 7, headSha: "aaa111" }),
        pullRequest({ number: 8, headRefName: "issue-8-x", headSha: "bbb222" }),
      ];
    },
  };
  const workspace = new FailingPushWorkspace();
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

  // Tick 1: both candidates soak green.
  expect((await service.runTick()).map((result) => result.tag)).toEqual(["soaking", "soaking"]);
  // Tick 2: PR 7 commits and its push fails — PR 8 must not even stage.
  const results = await service.runTick();
  expect(results[0]).toMatchObject({
    pullRequestNumber: 7,
    tag: "push-failed",
    note: expect.stringContaining("push failed"),
  });
  expect(results[1]).toMatchObject({ pullRequestNumber: 8, tag: "skipped" });
  const tickTwo = workspace.effects.slice(workspace.effects.indexOf("commit"));
  expect(tickTwo).toEqual(["commit", "push"]);
  expect(workspace.effects.filter((effect) => effect === "stage:bbb222")).toHaveLength(1);
});
