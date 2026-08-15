import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { configPath, resolvedPath, telemetryDir } from "@score/shared/config/layout";
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
    await requireReadableFile(configPath(), "config");
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
      await requireReadableFile(resolvedPath(key), `resolved:${key}`);
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

/**
 * readFile-based owners (loadConfig, readResolvedProject) block forever on
 * a FIFO — the probe must reject a non-regular entry by type before the
 * reader is ever called, or /readyz hangs instead of answering 503. A
 * missing entry passes through so the owner reports it in its own words.
 */
async function requireReadableFile(path: string, what: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw new Error(`${what} unreadable at ${path}: ${String(error)}`);
  }
  if (!isFile) throw new Error(`${what} is not a regular file at ${path}`);
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
    // segment, so readiness must not demand telemetry that was never
    // written. A dangling symlink at the store path is not that state —
    // the name is occupied, so the writer's recursive mkdir fails EEXIST
    // and the reader's scan finds nothing where segments should live.
    if ((error as { code?: string }).code === "ENOENT") {
      try {
        return !(await lstat(dir)).isSymbolicLink();
      } catch {
        return true; // genuinely absent
      }
    }
    return false;
  }
  for (const name of names) {
    if (!SEGMENT_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      // Type-check before any blocking open: a FIFO named like a segment
      // blocks a read-only open forever, and the reader's readFileSync
      // would never see it — only a path that is already a regular file
      // is worth probing further.
      if (!(await stat(path)).isFile()) return false;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") return false;
      // ENOENT with the name still occupying the directory: either
      // retention just deleted the entry, or a dangling symlink sits at
      // the segment path. The reader's snapshot includes the name and
      // expires cursors against it, so only an entry that is fully gone
      // may pass as retention — a link that still occupies the name
      // (lstat succeeds where stat failed) is an unreadable segment.
      try {
        if ((await lstat(path)).isSymbolicLink()) return false;
        continue;
      } catch {
        continue; // fully vanished by now — retention
      }
    }
    try {
      // The open is the permission probe: metadata stays readable on a
      // mode-000 file, but TelemetryLogService.readSegment() could not open
      // it — readiness must report what the reader can do. Nonblocking
      // closes the swap race: a FIFO replacing the file between stat and
      // open would block a plain read-only open forever; opened
      // nonblocking, the handle exists immediately and the fstat below
      // exposes whatever the descriptor actually points at.
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        // Handle-side stat covers an entry swapped between the calls.
        if (!(await handle.stat()).isFile()) return false;
        // Metadata is not readability: procfs-style regular files open and
        // fstat fine yet fail the read itself — prove the bytes come back.
        // A zero-byte segment (writer created it, no complete line yet)
        // reads zero bytes and passes; the syscall succeeding is the proof.
        await handle.read(Buffer.alloc(1), 0, 1, 0);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A segment vanishing mid-probe is retention doing its job — the
      // reader expires cursors past it, it does not flip readiness.
      if ((error as { code?: string }).code === "ENOENT") continue;
      return false;
    }
  }
  return true;
}
