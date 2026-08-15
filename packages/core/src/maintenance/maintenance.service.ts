import type { CleanupService } from "@score/core/cleanup/cleanup.service";
import type { CleanupResult } from "@score/core/cleanup/cleanup-result.interface";
import type { DispatchService } from "@score/core/dispatch/dispatch.service";
import type { DispatchResult } from "../dispatch/dispatch-result.interface";

export interface MaintenanceTickResult {
  readonly cleanup: readonly CleanupResult[];
  readonly dispatch: DispatchResult;
}

/**
 * Dispatch failed after cleanup had already run. The cleanup half of the
 * tick rides the error: its mutations happened, so its typed results must
 * survive the rejection instead of vanishing with the thrown tick — the
 * composition records them as telemetry evidence. Name and message mirror
 * the cause so prose failure reporting is unchanged.
 */
export class MaintenanceTickFailedError extends Error {
  readonly cleanup: readonly CleanupResult[];

  constructor(cleanup: readonly CleanupResult[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : "Error";
    this.cause = cause;
    this.cleanup = cleanup;
  }
}

/** Preserves the legacy safety ordering: observe merged cleanup before new dispatch. */
export class LegacyWorkflowService {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly dispatch: DispatchService,
  ) {}

  async runMaintenanceTick(dryRun = false): Promise<MaintenanceTickResult> {
    const cleanup = await this.cleanup.run(dryRun);
    try {
      const dispatch = await this.dispatch.run({ dryRun });
      return { cleanup, dispatch };
    } catch (cause) {
      throw new MaintenanceTickFailedError(cleanup, cause);
    }
  }
}
