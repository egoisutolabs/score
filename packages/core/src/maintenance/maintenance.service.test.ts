import type { CleanupService } from "@score/core/cleanup/cleanup.service";
import type { DispatchService } from "@score/core/dispatch/dispatch.service";
import { expect, test } from "vitest";
import { LegacyWorkflowService, MaintenanceTickFailedError } from "./maintenance.service";

function workflow(
  cleanupResult: { pullRequestNumber: number; action: "NOT_FOUND" }[],
  dispatchError: Error,
): LegacyWorkflowService {
  return new LegacyWorkflowService(
    { run: async () => cleanupResult } as unknown as CleanupService,
    {
      run: async () => {
        throw dispatchError;
      },
    } as unknown as DispatchService,
  );
}

test("a dispatch failure carries cleanup's results out on the wrapper", async () => {
  const cause = new Error("gh returned invalid JSON");
  const service = workflow([{ pullRequestNumber: 9, action: "NOT_FOUND" }], cause);

  const thrown = await service.runMaintenanceTick(true).then(
    () => undefined,
    (error) => error,
  );

  expect(thrown).toBeInstanceOf(MaintenanceTickFailedError);
  expect((thrown as MaintenanceTickFailedError).cleanup).toEqual([
    { pullRequestNumber: 9, action: "NOT_FOUND" },
  ]);
  // Name and message mirror the cause so prose failure reporting is unchanged.
  expect((thrown as MaintenanceTickFailedError).name).toBe("Error");
  expect(thrown?.message).toBe("gh returned invalid JSON");
  expect((thrown as MaintenanceTickFailedError).cause).toBe(cause);
});

test("the wrapper preserves the dispatch failure's original stack", async () => {
  const cause = new Error("observation died");
  cause.stack = "Error: observation died\n    at dispatch.service.ts:42:9";
  const service = workflow([], cause);

  const thrown = await service.runMaintenanceTick(true).then(
    () => undefined,
    (error) => error as MaintenanceTickFailedError,
  );

  // The daemon's phase-error path logs error.stack; it must land at the
  // dispatch origin, not at the maintenance wrapper's construction site.
  expect(thrown?.stack).toContain("at dispatch.service.ts:42:9");
});
