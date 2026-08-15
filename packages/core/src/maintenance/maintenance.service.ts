import type { CleanupService } from "@score/core/cleanup/cleanup.service";
import { CleanupTickFailedError } from "@score/core/cleanup/cleanup.service";
import type { CleanupResult } from "@score/core/cleanup/cleanup-result.interface";
import type { DispatchService } from "@score/core/dispatch/dispatch.service";
import { DispatchTickFailedError } from "@score/core/dispatch/dispatch.service";
import type { DispatchResult } from "../dispatch/dispatch-result.interface";

export interface MaintenanceTickResult {
  readonly cleanup: readonly CleanupResult[];
  readonly dispatch: DispatchResult;
}

/**
 * The tick failed after some of its work completed. Both halves' accumulated
 * results ride the error — cleanup mutations and dispatch starts genuinely
 * happened, so their typed evidence must survive the rejection instead of
 * vanishing with the thrown tick. Name and message mirror the cause so prose
 * failure reporting is unchanged.
 */
export class MaintenanceTickFailedError extends Error {
  readonly cleanup: readonly CleanupResult[];
  /** Dispatch's accumulated results; empty-shaped when dispatch never started. */
  readonly dispatch: DispatchResult;

  constructor(
    cleanup: readonly CleanupResult[],
    dispatch: DispatchResult | undefined,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : "Error";
    this.cause = cause;
    this.cleanup = cleanup;
    this.dispatch =
      dispatch ??
      ({
        started: [],
        planned: [],
        blocked: [],
        failed: [],
        capacity: { active: 0, max: 0, heldBy: [], starved: false },
      } as DispatchResult);
    // The wrapper's own stack would point here, burying the dispatch
    // operation that actually failed under the debug log's error.stack —
    // carry the cause's stack so diagnosis still lands at the origin.
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

/** Preserves the legacy safety ordering: observe merged cleanup before new dispatch. */
export class LegacyWorkflowService {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly dispatch: DispatchService,
  ) {}

  async runMaintenanceTick(dryRun = false): Promise<MaintenanceTickResult> {
    let cleanup: readonly CleanupResult[];
    try {
      cleanup = await this.cleanup.run(dryRun);
    } catch (cause) {
      // Cleanup failed mid-run: whatever it completed rides out, dispatch
      // never started.
      throw new MaintenanceTickFailedError(
        cause instanceof CleanupTickFailedError ? cause.partial : [],
        undefined,
        cause,
      );
    }
    try {
      const dispatch = await this.dispatch.run({ dryRun });
      return { cleanup, dispatch };
    } catch (cause) {
      throw new MaintenanceTickFailedError(
        cleanup,
        cause instanceof DispatchTickFailedError ? cause.partial : undefined,
        cause,
      );
    }
  }
}
