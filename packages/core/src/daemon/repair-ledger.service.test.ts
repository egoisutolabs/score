import { RepairLedger } from "@score/core/daemon/repair-ledger.service";
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
  pass(ledger, 1, ["score-issue-3"], BROKEN, "bbb", () => pinged("score-issue-3"));
  expect(ledger.exhaustion(9, false)).toEqual({
    budget: 2,
    waves: [
      { at: "T", tick: 0, headSha: "aaa", defects: BROKEN },
      { at: "T", tick: 1, headSha: "bbb", defects: BROKEN },
    ],
  });
});

test("a wait on pending checks keeps the wave count; a clean PR resets it", () => {
  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 1 });
  pass(ledger, 0, ["score-issue-3"], BROKEN, "aaa", () => pinged("score-issue-3"));
  ledger.startPass(1, new Set(["score-issue-3"]));
  ledger.finishPass([{ pullRequestNumber: 9, action: "CHECKS_PENDING", dryRun: false }]);
  expect(ledger.exhaustion(9, false)).toMatchObject({ budget: 1 });

  ledger.startPass(2, new Set(["score-issue-3"]));
  ledger.finishPass([{ pullRequestNumber: 9, action: "NOT_NEEDED", dryRun: false }]);
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

test("openFindingCount counts GitHub-open threads and the agent's own resolves, not a reviewer's", () => {
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
    resolvedBy: undefined,
  };
  ledger.recordFindings(9, [
    { ...base, threadId: "a", resolution: "open" },
    { ...base, threadId: "b", resolution: "self-resolved" },
    { ...base, threadId: "c", resolution: "reviewer-resolved" },
  ]);
  expect(ledger.openFindingCount(9)).toBe(2);
});
