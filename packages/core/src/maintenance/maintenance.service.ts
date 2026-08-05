import type { CleanupService } from "@score/core/cleanup/cleanup.service";
import type { CleanupResult } from "@score/core/cleanup/cleanup-result.interface";
import type { DispatchService } from "@score/core/dispatch/dispatch.service";
import type { DispatchResult } from "../dispatch/dispatch-result.interface";

export interface MaintenanceTickResult {
  readonly cleanup: readonly CleanupResult[];
  readonly dispatch: DispatchResult;
}

/** Preserves the legacy safety ordering: observe merged cleanup before new dispatch. */
export class LegacyWorkflowService {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly dispatch: DispatchService,
  ) {}

  async runMaintenanceTick(dryRun = false): Promise<MaintenanceTickResult> {
    const cleanup = await this.cleanup.run(dryRun);
    const dispatch = await this.dispatch.run({ dryRun });
    return { cleanup, dispatch };
  }
}
