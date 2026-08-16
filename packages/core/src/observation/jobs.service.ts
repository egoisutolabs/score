import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import type { JobStatus } from "../supervisor/supervisor-adapter.interface";
import { supervisorForPlatform } from "../supervisor/supervisor-adapter.interface";

/** Re-exported so observation surfaces never import the adapter module. */
export type { JobStatus };

/**
 * Read-only view of the supervisor's job table for observation surfaces
 * (snapshot stream, #81). Exposes status() alone: lifecycle authority stays
 * in the CLI/supervisor path (locked decision 6), and the no-lifecycle-route
 * guard in supervisor.run.test.ts bars HTTP-facing apps from importing the
 * adapter feature directly — this seam is what they read instead. An
 * unsupported platform or a failed read degrades to an empty table.
 */
export async function readSupervisorJobs(): Promise<readonly JobStatus[]> {
  try {
    return await supervisorForPlatform(new BunCommandRunner()).adapter.status();
  } catch {
    return [];
  }
}
