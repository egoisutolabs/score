import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  RepairLedgerEntry,
  RepairLedgerSnapshot,
} from "@score/core/daemon/repair-ledger.service";

/**
 * One JSON file per project, written whole via tmp + rename like status.json,
 * so a death mid-write leaves the previous snapshot, never a torn one. A
 * missing file is an empty ledger; a malformed one is an error the daemon
 * reports and starts over from — silently discarding it would hide the loss.
 */
export class RepairLedgerStore {
  constructor(private readonly path: string) {}

  async read(): Promise<RepairLedgerSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1 ||
      !isRecord((parsed as { pullRequests?: unknown }).pullRequests)
    ) {
      throw new Error(`${this.path} is not a v1 repair ledger`);
    }
    // Checked here, not on first use: a malformed entry that restored would
    // throw inside the repair phase on every tick, and the phase never
    // finishing means the file is never rewritten — a crash loop instead of
    // the "report and start empty" the header promises.
    for (const [number, entry] of Object.entries(
      (parsed as { pullRequests: Record<string, unknown> }).pullRequests,
    )) {
      if (!isLedgerEntry(entry)) {
        throw new Error(`${this.path} entry for PR ${number} is not a repair ledger entry`);
      }
    }
    return parsed as RepairLedgerSnapshot;
  }

  async write(snapshot: RepairLedgerSnapshot): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(tmp, this.path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RESOLUTIONS: ReadonlySet<unknown> = new Set(["open", "self-resolved", "reviewer-resolved"]);

function isDefects(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.conflicting === "boolean" &&
    typeof value.unresolvedThreads === "number" &&
    typeof value.failingChecks === "number" &&
    (value.buildRed === undefined || typeof value.buildRed === "string")
  );
}

/** What the convergence rules and the exhaustion comment read from a wave. */
function isWave(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.tick === "number" &&
    (value.headSha === undefined || typeof value.headSha === "string") &&
    isDefects(value.defects) &&
    typeof value.openFindings === "number" &&
    (value.diffSize === undefined || typeof value.diffSize === "number") &&
    typeof value.promptVersion === "string"
  );
}

/** What the tracker, the classifier, and the convergence rules read from a finding. */
function isFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.key === "string" &&
    typeof value.path === "string" &&
    typeof value.class === "string" &&
    typeof value.wave === "number" &&
    typeof value.fromLastFix === "boolean" &&
    RESOLUTIONS.has(value.resolution) &&
    (value.real === undefined || typeof value.real === "number")
  );
}

/**
 * The fields the ledger dereferences on an entry, and the shapes its rules
 * read inside waves and findings: four `{}` waves would otherwise restore as
 * a spent budget and park a PR on nothing.
 */
function isLedgerEntry(value: unknown): value is RepairLedgerEntry {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.waves) &&
    value.waves.every(isWave) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    isDefects(value.defects) &&
    typeof value.sessionName === "string" &&
    typeof value.labeled === "boolean" &&
    typeof value.tick === "number" &&
    (value.headSha === undefined || typeof value.headSha === "string") &&
    (value.firstHead === undefined || typeof value.firstHead === "string") &&
    (value.cleanSince === undefined || typeof value.cleanSince === "string") &&
    (value.cleanHead === undefined || typeof value.cleanHead === "string")
  );
}
