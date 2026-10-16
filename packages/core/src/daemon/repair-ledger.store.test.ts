import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepairLedger } from "@score/core/daemon/repair-ledger.service";
import { RepairLedgerStore } from "@score/core/daemon/repair-ledger.store";
import { afterEach, expect, test } from "vitest";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("a missing ledger file reads as empty; a written snapshot round-trips through restore", async () => {
  dir = await mkdtemp(join(tmpdir(), "score-ledger-"));
  const store = new RepairLedgerStore(join(dir, "nested", "repair-ledger.json"));
  expect(await store.read()).toBeUndefined();

  const ledger = new RepairLedger({ staleTicks: 10, roundBudget: 2, now: () => "T" });
  ledger.startPass(7, new Set(["score-issue-3"]));
  ledger.shouldAct(9, { conflicting: true, unresolvedThreads: 1, failingChecks: 0 }, "aaa");
  ledger.finishPass([
    { pullRequestNumber: 9, action: "PINGED", dryRun: false, target: "score-issue-3" },
  ]);
  await store.write(ledger.snapshot());

  const restored = new RepairLedger({ staleTicks: 10, roundBudget: 2 });
  const saved = await store.read();
  if (!saved) throw new Error("snapshot missing");
  restored.restore(saved);
  expect(restored.waveCount(9)).toBe(1);
  expect(restored.firstHead(9)).toBe("aaa");
  // Only the final file is left behind, never the tmp.
  expect(await readdir(join(dir, "nested"))).toEqual(["repair-ledger.json"]);
  expect(JSON.parse(await readFile(join(dir, "nested", "repair-ledger.json"), "utf8")).v).toBe(1);
});

test("a malformed ledger file is an error, not an empty ledger", async () => {
  dir = await mkdtemp(join(tmpdir(), "score-ledger-"));
  const path = join(dir, "repair-ledger.json");
  await writeFile(path, '{"v":2,"pullRequests":{}}');
  await expect(new RepairLedgerStore(path).read()).rejects.toThrow("not a v1 repair ledger");
  await writeFile(path, "{not json");
  await expect(new RepairLedgerStore(path).read()).rejects.toThrow();
});
