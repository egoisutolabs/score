import type { CommandRunner } from "@score/shared/command-runner.interface";
import type { JobStatus } from "../supervisor/supervisor-adapter.interface";
import { supervisorForPlatform } from "../supervisor/supervisor-adapter.interface";

/** Re-exported so observation surfaces never import the adapter module. */
export type { JobStatus };

/**
 * Read-only view of the supervisor's job table for observation surfaces
 * (snapshot stream, #81). Exposes status() alone: lifecycle authority stays
 * in the CLI/supervisor path (locked decision 6), and the no-lifecycle-route
 * guard in supervisor.run.test.ts bars HTTP-facing apps from importing the
 * adapter feature directly — this seam is what they read instead. The
 * runner is injected: core owns the port, composition stays in the app.
 */
export class SupervisorJobsReader {
  constructor(private readonly runner: CommandRunner) {}

  /**
   * Null on an unsupported platform or a failed read — never an empty
   * table, which would misreport every running daemon as disabled. Callers
   * surface the unknown explicitly instead of inventing job facts.
   */
  async read(): Promise<readonly JobStatus[] | null> {
    try {
      return await supervisorForPlatform(this.runner).adapter.status();
    } catch {
      return null;
    }
  }
}
