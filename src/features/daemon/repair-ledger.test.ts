import { expect, test } from "vitest";
import { RepairLedger } from "@/features/daemon/repair-ledger";
import type { RepairDefects } from "@/features/repair/policy";
import type { RepairResult } from "@/features/repair/result";

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
  const ledger = new RepairLedger(10);
  expect(
    pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3")),
  ).toBe(true);
  expect(pass(ledger, 1, ["score-issue-3"], CONFLICTING, "aaa", () => working)).toBe(false);
  expect(pass(ledger, 2, ["score-issue-3"], CONFLICTING, "aaa", () => working)).toBe(false);
});

test("a push that leaves the PR broken earns another ping", () => {
  const ledger = new RepairLedger(10);
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(
    pass(ledger, 1, ["score-issue-3"], CONFLICTING, "bbb", () => pinged("score-issue-3")),
  ).toBe(true);
});

test("a changed defect set earns another ping even without a push", () => {
  const ledger = new RepairLedger(10);
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(pass(ledger, 1, ["score-issue-3"], RED_CI, "aaa", () => pinged("score-issue-3"))).toBe(
    true,
  );
});

test("a dead session earns a respawn on the very next tick", () => {
  const ledger = new RepairLedger(10);
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(pass(ledger, 1, [], CONFLICTING, "aaa", () => pinged("score-issue-3"))).toBe(true);
});

test("a wedged agent that never pushes is re-pinged once staleTicks pass", () => {
  const ledger = new RepairLedger(3);
  pass(ledger, 0, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3"));
  expect(pass(ledger, 2, ["score-issue-3"], CONFLICTING, "aaa", () => working)).toBe(false);
  expect(
    pass(ledger, 3, ["score-issue-3"], CONFLICTING, "aaa", () => pinged("score-issue-3")),
  ).toBe(true);
});

test("a spawned agent is tracked by its shepherd session, and a fixed PR is forgotten", () => {
  const ledger = new RepairLedger(10);
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
  const ledger = new RepairLedger(10);
  ledger.startPass(0, new Set(["score-issue-3"]));
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(true);
  ledger.finishPass([{ ...pinged("score-issue-3"), dryRun: true }]);

  ledger.startPass(1, new Set(["score-issue-3"]));
  expect(ledger.shouldAct(9, CONFLICTING, "aaa")).toBe(true);
});
