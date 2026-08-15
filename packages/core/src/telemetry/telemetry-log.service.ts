/**
 * Append-only dated JSONL log: exactly one daemon appends, any reader tails
 * without coordination. Each record is one `write()` of `line + "\n"`, so a
 * torn write can only truncate the tail, never interleave. Telemetry is
 * never authoritative — an append failure counts and rate-limits an error
 * report, it never throws into a phase.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import type {
  TelemetryCursor,
  TelemetryFilter,
  TelemetryReadResult,
  TelemetryRecord,
  TelemetryResource,
} from "./telemetry.interface";
import { GAP_RECORD_NAME, TELEMETRY_VERSION } from "./telemetry.interface";
import { recordViolations } from "./telemetry.policy";

const SEGMENT_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const NEWLINE = 0x0a;
const ERROR_REPORT_INTERVAL_MS = 60_000;

export class TelemetryLogService {
  /** Dropped or failed appends; phases stay unaffected, the counter is the trace. */
  appendFailures = 0;

  private recovered = false;
  private lastErrorReportAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly dir: string,
    private readonly resource: TelemetryResource,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (message: string) => void = () => {},
  ) {}

  append(record: TelemetryRecord): void {
    try {
      const violations = recordViolations(record);
      // A record for another project would land in this project's segments
      // and misattribute telemetry to every reader — reject, never reroute.
      if (record.resource?.project !== this.resource.project)
        violations.push(`resource.project is not "${this.resource.project}"`);
      if (violations.length > 0) {
        this.fail(`telemetry record "${record.name}" rejected: ${violations.join("; ")}`);
        return;
      }
      if (!this.recovered) this.recoverTornWrite();
      this.writeLine(record);
    } catch (error) {
      this.fail(`telemetry append failed: ${String(error)}`);
    }
  }

  /**
   * Position at the oldest existing segment (or today when none exist yet)
   * so a new reader sees every retained record exactly once.
   */
  startCursor(): TelemetryCursor {
    return {
      project: this.resource.project,
      source: "telemetry",
      segment: this.listSegments()[0] ?? dateStamp(this.now()),
      byte_offset: 0,
    };
  }

  /**
   * Consume every complete line from the cursor forward, advancing across
   * segments. A trailing partial line is withheld until complete — its bytes
   * stay ahead of the cursor, so no byte is skipped or read twice.
   */
  read(cursor: TelemetryCursor, filter?: TelemetryFilter): TelemetryReadResult {
    const segments = this.listSegments();
    const oldest = segments[0];
    if (oldest !== undefined && cursor.segment < oldest) {
      // Retention deleted the cursor's segment — expire, never silently skip.
      return { outcome: "cursor-expired", records: [], warnings: [], cursor };
    }
    const records: TelemetryRecord[] = [];
    const warnings: string[] = [];
    const snapshot = new Set(segments);
    let segment = cursor.segment;
    let offset = cursor.byte_offset;
    for (;;) {
      const result = this.readSegment(segment, offset, filter, records, warnings);
      // A segment that was in this call's snapshot (or that the cursor had
      // already consumed bytes of) but whose file is gone was deleted by a
      // concurrent retention sweep — expire, never silently skip its records.
      // A date absent from the snapshot at offset 0 is just a day with no records.
      if (result.missing && (snapshot.has(segment) || offset > 0)) {
        return { outcome: "cursor-expired", records: [], warnings: [], cursor };
      }
      offset = result.offset;
      // Never advance past a withheld partial line: the writer's torn-write
      // recovery will terminate it, and only then do those bytes resolve.
      if (!result.complete) break;
      const next = segments.find((candidate) => candidate > segment);
      if (next === undefined) break;
      segment = next;
      offset = 0;
    }
    return {
      outcome: "ok",
      records,
      warnings,
      cursor: { ...cursor, segment, byte_offset: offset },
    };
  }

  /**
   * Deletes whole dated segments strictly older than the retention window —
   * same boundary rule as the prose log: a segment dated exactly `days` ago
   * survives. A directory that cannot be enumerated (EACCES, ENOTDIR, ...)
   * throws rather than reporting a successful sweep of nothing — the caller
   * must keep the day unswept and retry; only a missing directory has no
   * stale segments to delete.
   */
  sweepRetention(days: number): void {
    const cutoff = dateStamp(new Date(this.now().getTime() - days * 86_400_000));
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const date = SEGMENT_FILE.exec(name)?.[1];
      if (date !== undefined && date < cutoff) unlinkSync(join(this.dir, `${date}.jsonl`));
    }
  }

  /** Sorted ascending; segment names are dates, so lexical order is time order. */
  private listSegments(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => SEGMENT_FILE.exec(name)?.[1])
      .filter((date): date is string => date !== undefined)
      .sort();
  }

  private readSegment(
    date: string,
    offset: number,
    filter: TelemetryFilter | undefined,
    records: TelemetryRecord[],
    warnings: string[],
  ): { offset: number; complete: boolean; missing?: boolean } {
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(this.dir, `${date}.jsonl`));
    } catch {
      return { offset, complete: true, missing: true }; // read() decides: gap day or deleted
    }
    if (offset >= buffer.length) return { offset, complete: true };
    const pending = buffer.subarray(offset);
    const lastNewline = pending.lastIndexOf(NEWLINE);
    if (lastNewline === -1) return { offset, complete: false };
    for (const line of pending.subarray(0, lastNewline).toString("utf8").split("\n")) {
      this.parseLine(line, date, filter, records, warnings);
    }
    const consumed = offset + lastNewline + 1;
    return { offset: consumed, complete: consumed === buffer.length };
  }

  private parseLine(
    line: string,
    date: string,
    filter: TelemetryFilter | undefined,
    records: TelemetryRecord[],
    warnings: string[],
  ): void {
    if (line === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`unparseable line in ${date}.jsonl`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      warnings.push(`non-record line in ${date}.jsonl`);
      return;
    }
    // Unknown fields ride along untouched; only the version gates the line.
    const record = parsed as TelemetryRecord;
    if (record.version !== TELEMETRY_VERSION) {
      warnings.push(`unknown record version ${String(record.version)} in ${date}.jsonl`);
      return;
    }
    if (filter !== undefined && !matches(record, filter)) return;
    records.push(record);
  }

  /**
   * A restart after a mid-append death finds at most one unterminated
   * fragment at the tail of the newest segment. Terminate it so the next
   * record begins on a clean line, and emit a gap record as the evidence.
   */
  private recoverTornWrite(): void {
    mkdirSync(this.dir, { recursive: true });
    const newest = this.listSegments().at(-1);
    if (newest !== undefined) {
      const path = join(this.dir, `${newest}.jsonl`);
      const size = statSync(path).size;
      if (size > 0 && readByteAt(path, size - 1) !== NEWLINE) {
        const gap: TelemetryRecord = {
          version: TELEMETRY_VERSION,
          time: this.now().toISOString(),
          name: GAP_RECORD_NAME,
          kind: "event",
          resource: this.resource,
          attributes: { segment: newest },
        };
        // One write into the torn segment itself: the terminator and the gap
        // evidence land together or not at all, so a death mid-recovery can
        // never leave a cleanly-terminated fragment with its gap record lost.
        appendFileSync(path, `\n${JSON.stringify(gap)}\n`);
      }
    }
    // Only after success — a throw above leaves recovery pending, and the
    // next append retries it instead of concatenating onto the fragment.
    this.recovered = true;
  }

  private writeLine(record: TelemetryRecord): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${dateStamp(this.now())}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  private fail(message: string): void {
    this.appendFailures += 1;
    const at = this.now().getTime();
    if (at - this.lastErrorReportAt < ERROR_REPORT_INTERVAL_MS) return;
    this.lastErrorReportAt = at;
    try {
      this.onError(message);
    } catch {
      // A throwing reporter must not escape into a phase — telemetry is never authoritative.
    }
  }
}

function matches(record: TelemetryRecord, filter: TelemetryFilter): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(record.kind)) return false;
  if (
    filter.names !== undefined &&
    !filter.names.some((name) => record.name === name || record.name.startsWith(`${name}.`))
  )
    return false;
  if (filter.session !== undefined && record.subject?.session !== filter.session) return false;
  if (filter.branch !== undefined && record.subject?.branch !== filter.branch) return false;
  return true;
}

function readByteAt(path: string, position: number): number {
  const fd = openSync(path, "r");
  try {
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, position);
    return byte[0] ?? NEWLINE;
  } finally {
    closeSync(fd);
  }
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}
