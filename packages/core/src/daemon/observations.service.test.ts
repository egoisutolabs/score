import { PassCachedChangeHost } from "@score/core/daemon/observations.service";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import { expect, test } from "vitest";

function countingHost() {
  const calls = { heads: 0, repair: 0 };
  const inner: ChangeHost = {
    async observeOpenChanges() {
      return [];
    },
    async observeOpenChangeHeads() {
      calls.heads += 1;
      return [{ number: 7, headRefName: "issue-1-x" }];
    },
    async observeRepairChanges() {
      calls.repair += 1;
      return [];
    },
    async observeMergedOwnedChanges() {
      return [];
    },
    async unresolvedThreadCount() {
      return 0;
    },
  };
  return { calls, inner };
}

test("repeated in-flight lookups cost one gh call per pass", async () => {
  const { calls, inner } = countingHost();
  const host = new PassCachedChangeHost(inner);

  host.startPass();
  expect((await host.observeOpenChangeHeads())[0]?.number).toBe(7);
  await host.observeOpenChangeHeads();
  await host.observeOpenChangeHeads();
  expect(calls.heads).toBe(1);

  host.startPass();
  await host.observeOpenChangeHeads();
  expect(calls.heads).toBe(2);
});

test("repair observations are never cached: landing merges mid-pass", async () => {
  const { calls, inner } = countingHost();
  const host = new PassCachedChangeHost(inner);

  host.startPass();
  await host.observeRepairChanges();
  await host.observeRepairChanges();
  expect(calls.repair).toBe(2);
});
