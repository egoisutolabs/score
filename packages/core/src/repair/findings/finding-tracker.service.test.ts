import { expect, test } from "vitest";
import type {
  BlameSource,
  FindingLedger,
  FindingRecord,
  ReviewThreadObservation,
} from "./finding.interface";
import { FindingTracker } from "./finding-tracker.service";

class MemoryLedger implements FindingLedger {
  records = new Map<number, readonly FindingRecord[]>();
  waves = 0;
  head: string | undefined;
  findings(number: number) {
    return this.records.get(number) ?? [];
  }
  firstHead() {
    return this.head;
  }
  lastWaveHead() {
    return this.head;
  }
  waveCount() {
    return this.waves;
  }
  recordFindings(number: number, records: readonly FindingRecord[]) {
    this.records.set(number, records);
  }
}

class FakeBlame implements BlameSource {
  blamed: string[] = [];
  origins = new Map<string, string>();
  files = new Map<string, string>();
  fail = false;
  async blameOrigin(commit: string, path: string, line: number) {
    this.blamed.push(`${commit}:${path}:${line}`);
    if (this.fail) throw new Error("blame died");
    return this.origins.get(`${commit}:${path}:${line}`);
  }
  async fileAt(commit: string, path: string) {
    if (this.fail) throw new Error("show died");
    return this.files.get(`${commit}:${path}`);
  }
  // "base" and anything blamed to "old" predate the first head; "fix" does
  // not; "lost" is an object git can no longer find.
  async ancestry(ancestor: string, _descendant: string) {
    if (ancestor === "lost") return undefined;
    return ancestor !== "fix";
  }
}

function thread(
  id: string,
  overrides: Partial<ReviewThreadObservation> = {},
): ReviewThreadObservation {
  return {
    id,
    path: "src/a.ts",
    originalLine: 3,
    originalCommit: "rev",
    author: "chatgpt-codex-connector",
    createdAt: "2026-10-16T00:00:00Z",
    isResolved: false,
    resolvedBy: undefined,
    ...overrides,
  };
}

const SOURCE = "export function save() {\n  const x = 1;\n  return x;\n}\n";

test("a new thread is blamed once, keyed by origin + path + symbol, and classified against the ledger", async () => {
  const blame = new FakeBlame();
  blame.origins.set("rev:src/a.ts:3", "fix");
  blame.files.set("rev:src/a.ts", SOURCE);
  const ledger = new MemoryLedger();
  ledger.waves = 1;
  ledger.head = "base";
  const tracker = new FindingTracker(blame, ledger);

  const first = await tracker.observe(9, [thread("T1")]);
  expect(first[0]).toMatchObject({
    threadId: "T1",
    key: "fix:src/a.ts:save",
    symbol: "save",
    origin: "fix",
    class: "regression-from-fix",
    wave: 1,
    resolution: "open",
  });
  expect(blame.blamed).toEqual(["rev:src/a.ts:3"]);

  // Second pass: the thread is known, so only its resolution is refreshed — no blame.
  const second = await tracker.observe(9, [
    thread("T1", { isResolved: true, resolvedBy: "gendev1" }),
  ]);
  expect(second[0]).toMatchObject({ key: "fix:src/a.ts:save", resolution: "self-resolved" });
  expect(blame.blamed).toEqual(["rev:src/a.ts:3"]);
});

test("the same key after a self-resolve is fix-failed; two reviewers in one round are a duplicate", async () => {
  const blame = new FakeBlame();
  blame.origins.set("rev:src/a.ts:3", "old");
  blame.origins.set("rev2:src/a.ts:3", "old");
  blame.files.set("rev:src/a.ts", SOURCE);
  blame.files.set("rev2:src/a.ts", SOURCE);
  const ledger = new MemoryLedger();
  ledger.waves = 1;
  ledger.head = "base";
  const tracker = new FindingTracker(blame, ledger);

  await tracker.observe(9, [thread("T1", { isResolved: true, resolvedBy: "gendev1" })]);
  ledger.waves = 2;
  const records = await tracker.observe(9, [
    thread("T1", { isResolved: true, resolvedBy: "gendev1" }),
    thread("T2", { originalCommit: "rev2" }),
    thread("T3", { originalCommit: "rev2", author: "claude[bot]" }),
  ]);
  expect(records.map((record) => [record.threadId, record.class])).toEqual([
    ["T1", "missed-earlier"],
    ["T2", "fix-failed"],
    ["T3", "fix-failed"],
  ]);
  // T3 is the other reviewer's open copy of T2's defect within the same pass:
  // once T1's self-resolve is out of the picture it reads as a duplicate.
  const ledger2 = new MemoryLedger();
  ledger2.waves = 1;
  ledger2.head = "base";
  const pair = await new FindingTracker(blame, ledger2).observe(9, [
    thread("T2", { originalCommit: "rev2" }),
    thread("T3", { originalCommit: "rev2", author: "claude[bot]" }),
  ]);
  expect(pair.map((record) => record.class)).toEqual(["missed-earlier", "duplicate"]);
});

test("a blame failure degrades the key to the reviewed commit and never fails the pass", async () => {
  const blame = new FakeBlame();
  blame.fail = true;
  const ledger = new MemoryLedger();
  ledger.waves = 1;
  ledger.head = "base";
  const records = await new FindingTracker(blame, ledger).observe(9, [thread("T1")]);
  expect(records[0]).toMatchObject({
    key: "rev:src/a.ts:L3",
    origin: undefined,
    symbol: undefined,
    class: "missed-earlier",
  });
});

test("a thread GitHub stopped returning drops out of the ledger; a file-level thread is keyed by line 0", async () => {
  const blame = new FakeBlame();
  const ledger = new MemoryLedger();
  const tracker = new FindingTracker(blame, ledger);
  await tracker.observe(9, [thread("T1"), thread("T2", { originalLine: null })]);
  expect(ledger.findings(9).map((record) => record.key)).toEqual([
    "rev:src/a.ts:L3",
    "rev:src/a.ts:L0",
  ]);
  expect(blame.blamed).toEqual(["rev:src/a.ts:3"]);
  await tracker.observe(9, [thread("T2", { originalLine: null })]);
  expect(ledger.findings(9).map((record) => record.threadId)).toEqual(["T2"]);
});

test("fromLastFix compares the origin against the latest wave's head, and a classifier can annotate the record", async () => {
  const blame = new FakeBlame();
  blame.origins.set("rev:src/a.ts:3", "fix");
  blame.files.set("rev:src/a.ts", SOURCE);
  const ledger = new MemoryLedger();
  ledger.waves = 2;
  ledger.head = "base";
  const lastHeads: (string | undefined)[] = [];
  const ledgerWithLast: FindingLedger = {
    ...ledger,
    findings: (n) => ledger.findings(n),
    firstHead: () => ledger.firstHead(),
    waveCount: () => ledger.waveCount(),
    lastWaveHead: () => lastHeads.shift(),
    recordFindings: (n, r) => ledger.recordFindings(n, r),
  };
  const classifier = {
    async assess() {
      return { real: 0.3 };
    },
  };
  const tracker = new FindingTracker(blame, ledgerWithLast, classifier);

  // Latest wave head "base": "fix" is not its ancestor → written by the fix.
  lastHeads.push("base");
  const [first] = await tracker.observe(9, [thread("T1")]);
  expect(first).toMatchObject({ fromLastFix: true, real: 0.3 });

  // No wave yet (fresh PR): nothing can be "from the last fix".
  lastHeads.push(undefined);
  const [second] = await tracker.observe(9, [thread("T2")]);
  expect(second).toMatchObject({ fromLastFix: false });
});

test("git failing to decide ancestry is unknown: not a regression, not written by the fix", async () => {
  const blame = new FakeBlame();
  blame.origins.set("rev:src/a.ts:3", "lost");
  blame.files.set("rev:src/a.ts", SOURCE);
  const ledger = new MemoryLedger();
  ledger.waves = 1;
  ledger.head = "base";
  const [record] = await new FindingTracker(blame, ledger).observe(9, [thread("T1")]);
  expect(record).toMatchObject({ origin: "lost", class: "missed-earlier", fromLastFix: false });
});
