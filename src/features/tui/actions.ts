import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectDir } from "@/features/config/layout";
import type { SupervisorAdapter } from "@/features/supervisor/adapter";

/** The definition copy `score up` keeps in the state dir (issue 5's contract). */
function jobDefinitionPath(key: string): string {
  return join(projectDir(key), "job.plist");
}

async function readDefinition(key: string): Promise<string> {
  const definition = await readFile(jobDefinitionPath(key), "utf8").catch(() => null);
  if (definition === null) {
    throw new Error(`no job definition for '${key}' — run: score up ${key}`);
  }
  return definition;
}

/**
 * `stop()` deregisters the job (keeping its definition file), so starting a
 * booted-out project re-registers it from the saved copy before starting —
 * the same install-then-start sequence `score up` performs, adapter-only.
 * A crashed job is still registered, so re-installing would fail; it only
 * needs a start.
 */
export async function startProject(
  adapter: SupervisorAdapter,
  key: string,
  stillRegistered = false,
): Promise<void> {
  if (!stillRegistered) {
    await adapter.install(key, await readDefinition(key));
  }
  await adapter.start(key);
}

export function stopProject(adapter: SupervisorAdapter, key: string): Promise<void> {
  return adapter.stop(key);
}

export async function restartProject(adapter: SupervisorAdapter, key: string): Promise<void> {
  // Read the definition before stopping: a missing saved plist must fail
  // without booting out a running daemon it can't bring back.
  const definition = await readDefinition(key);
  await adapter.stop(key);
  await adapter.install(key, definition);
  await adapter.start(key);
}
