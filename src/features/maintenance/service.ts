import type { CleanupResult } from "@/features/cleanup/result";
import type { CleanupService } from "@/features/cleanup/service";
import type { DispatchResult } from "@/features/dispatch/result";
import type { DispatchService } from "@/features/dispatch/service";

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
