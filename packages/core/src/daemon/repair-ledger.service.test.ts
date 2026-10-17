import { RepairLedger } from "@score/core/daemon/repair-ledger.service";
import { REPAIR_PROMPT_VERSION } from "@score/core/prompts/repair.render";
import type { RepairDefects } from "@score/core/repair/repair.policy";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import { expect, test } from "vitest";

const CONFLICTING: RepairDefects = { conflicting: true, unresolvedThreads: 0, failingChecks: 0 };
const RED_CI: RepairDefects = { conflicting: true, unresolvedThreads: 0, failingChecks: 1 };

function pinged(session: string): RepairResult {
  return { pullRequestNumber: 9, action: "PINGED", dryRun: false, target: session };
}

/** One pass: ask, then report back what the service did. */
function pass(
  ledger: RepairLedger,
  tick: number,
  sessions: readonly string[],
  defects: RepairDefects,
  headSha: string | undefined,
  onAct: (acted: boolean) => RepairResult,
): boolean {
  ledger.startPass(tick, new Set(sessions));
  const acted = ledger.shouldAct(9, defects, headSha);
  ledger.finishPass([onAct(acted)]);
  return acted;
}

const working: RepairResult = { pullRequestNumber: 9, action: "WORKING", dryRun: false };

test("a pinged agent is left alone while its session lives and nothing moved", () => {
  const ledger = new RepairLedger({ staleTicks: 10 });
  expect(
    pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3")),
  ).toBe(true);
  expect(pass(ledger, 1, ["score-issue-3"], CONFLICTING, "aaa", () => working)).toBe(false);
  expect(pass(ledger, 2, ["score-issue-3"], CONFLICTING, "aaa", () => working)).toBe(false);
});

test("a push that leaves the PR broken earns another ping", () => {
  const ledger = new RepairLedger({ staleTicks: 10 });
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(
    pass(ledger, 1, ["score-issue-3"], CONFLICTING, "bbb", () => pinged("score-issue-3")),
  ).toBe(true);
});

test("a changed defect set earns another ping even without a push", () => {
  const ledger = new RepairLedger({ staleTicks: 10 });
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(pass(ledger, 1, ["score-issue-3"], RED_CI, "aaa", () => pinged("score-issue-3"))).toBe(
    true,
  );
});

test("a dead session earns a respawn on the very next tick", () => {
  const ledger = new RepairLedger({ staleTicks: 10 });
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(pass(ledger, 1, [], CONFLICTING, "aaa", () => pinged("score-issue-3"))).toBe(true);
});

test("a wedged agent that never pushes is re-pinged once staleTicks pass", () => {
  const ledger = new RepairLedger({ staleTicks: 3 });
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(pass(ledger, 2, ["score-issue-3"], CONFLICTING, "aaa", () => working)).toBe(false);
  expect(
    pass(ledger, 3, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3")),
  ).toBe(true);
});

test("a spawned agent is tracked by its shepherd session, and a fixed PR is forgotten", () => {
  const ledger = new RepairLedger({ staleTicks: 10 });
  ledger.startPass(0, new Set());
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(true);
  ledger.finishPass([{ pullRequestNumber: 9, action: "SPAWNED", dryRun: false, target: "/wt/x" }]);

  ledger.startPass(1, new Set(["shepherd-pr-9"]));
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(false);

  // PR goes clean: the entry is dropped, so a later break pings immediately.
  ledger.finishPass([{ pullRequestNumber: 9, action: "NOT_NEEDED", dryRun: false }]);
  ledger.startPass(2, new Set(["shepherd-pr-9"]));
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(true);
});

test("a dry run records nothing, so the next real pass still acts", () => {
  const ledger = new RepairLedger({ staleTicks: 10 });
  ledger.startPass(0, new Set(["score-issue-3"]));
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(true);
  ledger.finishPass([{ ...pinged("score-issue-3"), dryRun: true }]);

  ledger.startPass(1, new Set(["score-issue-3"]));
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(true);
});

test("a namespaced spawn is tracked under the session name the adapter actually creates", () => {
  const ledger = new RepairLedger({ staleTicks: 10, namespace: "demo" });
  ledger.startPass(0, new Set());
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(true);
  ledger.finishPass([{ pullRequestNumber: 9, action: "SPAWNED", dryRun: false, target: "/wt/x" }]);

  // The adapter created score-demo-shepherd-pr-9; the liveness check must
  // match it, or every tick tears down and recreates the live repair.
  ledger.startPass(1, new Set(["score-demo-shepherd-pr-9"]));
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(false);
});

// Round budget (review-loop analysis §2.2).

const BROKEN: RepairDefects = { conflicting: false, unresolvedThreads: 2, failingChecks: 0 };

test("the budget counts pings and spawns; once spent, exhaustion returns the wave history", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 2, now: () => "T" });
  expect(ledger.exhaustion(9, false)).toBeUndefined();
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  expect(ledger.exhaustion(9, false)).toBeUndefined();
  // The agent pushed and the PR is still broken: round two.
  ledger.startPass(1, new Set(["score-issue-3"]));
  expect(ledger.shouldAct(9, BROKEN, "bbb", 12)).toBe(true);
  ledger.finishPass([pinged("score-issue-3")]);
  expect(ledger.exhaustion(9, false)).toEqual({
    budget: 2,
    rule: "budget",
    detail: "2 wave(s) used the budget of 2",
    waves: [
      {
        at: "T",
        tick: 0,
        headSha: "aaa",
        defects: BROKEN,
        openFindings: 0,
        diffSize: undefined,
        promptVersion: REPAIR_PROMPT_VERSION,
      },
      {
        at: "T",
        tick: 1,
        headSha: "bbb",
        defects: BROKEN,
        openFindings: 0,
        diffSize: 12,
        promptVersion: REPAIR_PROMPT_VERSION,
      },
    ],
  });
});

test("a wait on pending checks or a failed thread query keeps the wave count; a clean PR resets it", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 1 });
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  ledger.startPass(1, new Set(["score-issue-3"]));
  ledger.finishPass([{ pullRequestNumber: 9, action: "CHECKS_PENDING", dryRun: false }]);
  expect(ledger.exhaustion(9, false)).toMatchObject({ budget: 1 });

  ledger.startPass(2, new Set(["score-issue-3"]));
  ledger.finishPass([{ pullRequestNumber: 9, action: "UNOBSERVED", dryRun: false }]);
  expect(ledger.exhaustion(9, false)).toMatchObject({ budget: 1 });

  // Still defective, but no session and no worktree to send to: not clean.
  ledger.startPass(3, new Set());
  ledger.finishPass([{ pullRequestNumber: 9, action: "SKIPPED", dryRun: false }]);
  expect(ledger.exhaustion(9, false)).toMatchObject({ budget: 1 });

  ledger.startPass(4, new Set(["score-issue-3"]));
  ledger.finishPass([{ pullRequestNumber: 9, action: "NOT_NEEDED", dryRun: false }]);
  expect(ledger.exhaustion(9, false)).toBeUndefined();
});

test("with a settle window, a clean PR keeps its waves until it has stayed clean that long", () => {
  const clock = { now: Date.parse("2026-10-17T10:00:00Z") };
  const ledger = new RepairLedger({
    staleTicks: 10,
    roundBudget: 1,
    settleMs: 10 * 60_000,
    now: () => new Date(clock.now).toISOString(),
  });
  const clean: RepairResult = {
    pullRequestNumber: 9,
    action: "NOT_NEEDED",
    dryRun: false,
    headSha: "aaa",
  };
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));

  // Checks reported, nothing wrong — but Codex posts no check, so its review
  // of this head may still be coming: the budget stands.
  ledger.startPass(1, new Set());
  ledger.finishPass([clean]);
  clock.now += 9 * 60_000;
  ledger.startPass(2, new Set());
  ledger.finishPass([clean]);
  expect(ledger.waveCount(9)).toBe(1);
  expect(ledger.exhaustion(9, false)).toMatchObject({ budget: 1 });

  // A push restarts the clock: pending checks, then clean again from zero.
  ledger.startPass(3, new Set());
  ledger.finishPass([{ pullRequestNumber: 9, action: "CHECKS_PENDING", dryRun: false }]);
  clock.now += 5 * 60_000;
  ledger.startPass(4, new Set());
  ledger.finishPass([clean]);
  clock.now += 9 * 60_000;
  ledger.startPass(5, new Set());
  ledger.finishPass([clean]);
  expect(ledger.waveCount(9)).toBe(1);

  // A push whose checks finished between passes never showed as pending: the
  // new head on a clean result restarts the clock all the same.
  ledger.startPass(6, new Set());
  ledger.finishPass([{ ...clean, headSha: "bbb" }]);
  clock.now += 9 * 60_000;
  ledger.startPass(7, new Set());
  ledger.finishPass([{ ...clean, headSha: "bbb" }]);
  expect(ledger.waveCount(9)).toBe(1);

  // Clean for the whole window on one head: fresh budget, history kept.
  clock.now += 60_000;
  ledger.startPass(8, new Set());
  ledger.finishPass([{ ...clean, headSha: "bbb" }]);
  expect(ledger.waveCount(9)).toBe(0);
  expect(ledger.firstHead(9)).toBe("aaa");
  expect(ledger.exhaustion(9, false)).toBeUndefined();
});

test("an exhausted PR stays parked while labeled; removing the label grants a fresh budget", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 1 });
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  ledger.startPass(1, new Set(["score-issue-3"]));
  expect(ledger.exhaustion(9, false)).toMatchObject({ budget: 1 });
  ledger.finishPass([
    { pullRequestNumber: 9, action: "EXHAUSTED", dryRun: false, target: "repair-exhausted" },
  ]);

  // Still labeled on later passes: the service parks it before asking; the
  // entry survives so the history is not lost while parked.
  ledger.startPass(2, new Set(["score-issue-3"]));
  ledger.finishPass([
    { pullRequestNumber: 9, action: "EXHAUSTED", dryRun: false, target: "repair-exhausted" },
  ]);

  // A human removed the label: the next question starts a fresh budget.
  ledger.startPass(3, new Set(["score-issue-3"]));
  expect(ledger.exhaustion(9, false)).toBeUndefined();
  expect(ledger.shouldAct(9, BROKEN, "aaa")).toBe(true);
});

test("a fresh budget ends the old episode: a regression from its last fix cannot re-park the PR", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 4 });
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  // The reviewer blamed a finding to that fix: rule 3 parks the PR.
  ledger.recordFindings(9, [
    {
      threadId: "T1",
      key: "k",
      path: "a.ts",
      symbol: "f",
      origin: "bbb",
      author: "codex",
      createdAt: "",
      class: "regression-from-fix",
      wave: 1,
      fromLastFix: true,
      resolution: "open",
      resolvedBy: undefined,
    },
  ]);
  ledger.startPass(1, new Set(["score-issue-3"]));
  expect(ledger.exhaustion(9, false)).toMatchObject({ rule: "regression-from-fix" });
  ledger.finishPass([
    { pullRequestNumber: 9, action: "EXHAUSTED", dryRun: false, target: "repair-exhausted" },
  ]);

  // Label removed, one new wave sent: the new episode is at wave 1 too, but
  // the old record no longer blames to anything the new budget sent.
  ledger.startPass(2, new Set(["score-issue-3"]));
  expect(ledger.exhaustion(9, false)).toBeUndefined();
  expect(ledger.shouldAct(9, BROKEN, "bbb")).toBe(true);
  ledger.finishPass([pinged("score-issue-3")]);
  ledger.startPass(3, new Set(["score-issue-3"]));
  expect(ledger.exhaustion(9, false)).toBeUndefined();
  expect(ledger.findings(9)[0]?.fromLastFix).toBe(false);
});

test("a dry-run exhaustion records nothing, so the next real pass still marks the PR", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 1 });
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  ledger.startPass(1, new Set(["score-issue-3"]));
  ledger.finishPass([{ pullRequestNumber: 9, action: "EXHAUSTED", dryRun: true }]);
  ledger.startPass(2, new Set(["score-issue-3"]));
  expect(ledger.exhaustion(9, false)).toMatchObject({ budget: 1 });
});

// Persistence and finding memory (review-loop analysis §2.4).

test("restore keeps budget, waves, label state, and findings; the tick is clamped to the new process", () => {
  const ledger = new RepairLedger({ staleTicks: 3, roundBudget: 2, now: () => "T" });
  pass(ledger, 40, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  ledger.recordFindings(9, [
    {
      threadId: "T1",
      key: "k",
      path: "a.ts",
      symbol: "f",
      origin: "o",
      author: "codex",
      createdAt: "",
      class: "first-round",
      wave: 0,
      fromLastFix: false,
      resolution: "open",
      resolvedBy: undefined,
    },
  ]);

  const restored = new RepairLedger({ staleTicks: 3, roundBudget: 2 });
  restored.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
  expect(restored.waveCount(9)).toBe(1);
  expect(restored.firstHead(9)).toBe("aaa");
  expect(restored.findings(9).map((record) => record.threadId)).toEqual(["T1"]);
  // Tick 41 in the old process; the new process is at tick 1 — the agent is
  // still inside its staleTicks window, not 40 ticks overdue or 40 ticks early.
  expect(pass(restored, 1, ["score-issue-3"], BROKEN, "aaa", () => working)).toBe(false);
  expect(pass(restored, 3, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"))).toBe(
    true,
  );
  expect(restored.exhaustion(9, false)).toMatchObject({ budget: 2 });
});

test("a PR that goes clean keeps its findings and first head but starts a fresh budget", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 1 });
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  ledger.recordFindings(9, []);
  ledger.startPass(1, new Set());
  ledger.finishPass([{ pullRequestNumber: 9, action: "NOT_NEEDED", dryRun: false }]);
  expect(ledger.waveCount(9)).toBe(0);
  expect(ledger.firstHead(9)).toBe("aaa");
  expect(ledger.exhaustion(9, false)).toBeUndefined();

  // Gone from the scan (merged or closed): forgotten entirely.
  ledger.startPass(2, new Set());
  ledger.finishPass([]);
  expect(ledger.firstHead(9)).toBeUndefined();
});

test("openFindingCount counts GitHub-open threads once per key; unconfirmedFindingCount adds the agent's own resolves", () => {
  const ledger = new RepairLedger({ staleTicks: 10 });
  const base = {
    key: "k",
    path: "a.ts",
    symbol: undefined,
    origin: undefined,
    author: "codex",
    createdAt: "",
    class: "first-round" as const,
    wave: 0,
    fromLastFix: false,
    resolvedBy: undefined,
  };
  ledger.recordFindings(9, [
    { ...base, threadId: "a", resolution: "open" },
    { ...base, key: "k2", threadId: "b", resolution: "self-resolved" },
    { ...base, key: "k3", threadId: "c", resolution: "reviewer-resolved" },
    // A second reviewer raising the same defect is one thing left to fix.
    { ...base, threadId: "d", author: "claude[bot]", class: "duplicate", resolution: "open" },
  ]);
  // Convergence sees what the reviewer still holds open: k (twice) → 1. A
  // self-resolve is not in it, or the count could never fall.
  expect(ledger.openFindingCount(9)).toBe(1);
  // Open at merge keeps the agent's own resolves: k and k2.
  expect(ledger.unconfirmedFindingCount(9)).toBe(2);
});

test("a convergence rule parks the PR before the budget, naming the rule in the exhaustion", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 8, now: () => "T" });
  // Three waves with findings that never go down: rule 1 fires at wave three.
  for (const [tick, sha] of [
    [0, "a"],
    [1, "b"],
    [2, "c"],
  ] as const) {
    ledger.startPass(tick, new Set(["score-issue-3"]));
    ledger.recordFindings(9, [
      {
        threadId: `T${tick}`,
        key: `k${tick}`,
        path: "a.ts",
        symbol: "f",
        origin: sha,
        author: "codex",
        createdAt: "",
        class: "first-round" as const,
        wave: tick,
        fromLastFix: false,
        resolution: "open" as const,
        resolvedBy: undefined,
      },
      ...ledger.findings(9),
    ]);
    expect(ledger.exhaustion(9, false)).toBeUndefined();
    expect(ledger.shouldAct(9, BROKEN, sha)).toBe(true);
    ledger.finishPass([pinged("score-issue-3")]);
  }
  expect(ledger.exhaustion(9, false)).toMatchObject({
    rule: "findings-flat",
    detail: "open findings 1 → 2 → 3 over the last three waves",
    budget: 8,
  });
  expect(ledger.lastWaveHead(9)).toBe("c");
});
