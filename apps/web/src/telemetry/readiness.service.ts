import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { telemetryDir } from "@score/shared/config/layout";
import { loadConfig } from "@score/shared/config/load";
import { readResolvedProject } from "@score/shared/config/resolved";

/**
 * The /readyz probe: can the app read everything a stream would serve —
 * the config, each selected project's resolved config, and its retained
 * telemetry segments. Read-only by construction; an unreadable store flips
 * readiness, never liveness (/healthz knows nothing about files).
 */
export interface ReadinessCheck {
  readonly name: string;
  readonly ready: boolean;
  readonly reason_code?: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
}

/** Dated segment files, the only names a reader ever selects from the store. */
const SEGMENT_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export async function assessReadiness(): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  let selected: string[] = [];
  try {
    const config = await loadConfig();
    checks.push({ name: "config", ready: true });
    // Disabled projects have no daemon and no store — probing them would
    // report red for a project the stream is not allowed to select anyway.
    selected = Object.entries(config.projects)
      .filter(([, project]) => project.enabled)
      .map(([key]) => key)
      .sort();
  } catch {
    checks.push({ name: "config", ready: false, reason_code: "config-unreadable" });
    return { ready: false, checks };
  }
  for (const key of selected) {
    try {
      await readResolvedProject(key);
      checks.push({ name: `resolved:${key}`, ready: true });
    } catch {
      checks.push({ name: `resolved:${key}`, ready: false, reason_code: "resolved-unreadable" });
    }
    checks.push(await telemetryCheck(key));
  }
  return { ready: checks.every((check) => check.ready), checks };
}

async function telemetryCheck(key: string): Promise<ReadinessCheck> {
  const name = `telemetry:${key}`;
  const readable = await telemetryReadable(key);
  return readable
    ? { name, ready: true }
    : { name, ready: false, reason_code: "telemetry-unreadable" };
}

async function telemetryReadable(key: string): Promise<boolean> {
  const dir = telemetryDir(key);
  let names: string[];
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return false; // a file where the store belongs
    names = await readdir(dir);
  } catch (error) {
    // No store yet is a valid empty state: a reader starts at today's
    // segment, so readiness must not demand telemetry that was never written.
    if ((error as { code?: string }).code === "ENOENT") return true;
    return false;
  }
  for (const name of names) {
    if (!SEGMENT_FILE.test(name)) continue;
    try {
      await stat(join(dir, name));
    } catch (error) {
      // A segment vanishing mid-probe is retention doing its job — the
      // reader expires cursors past it, it does not flip readiness.
      if ((error as { code?: string }).code === "ENOENT") continue;
      return false;
    }
  }
  return true;
}
