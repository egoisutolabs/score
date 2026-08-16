/**
 * Append-only dated JSONL telemetry log: exactly one daemon appends, any
 * reader tails without coordination. Each record is one write() of
 * `line + "\n"`, so a torn write can only truncate the tail, never
 * interleave; readers withhold a trailing run without `\n` entirely.
 * Ceilings by design: no fsync per record, no lock files, no rename dances
 * — a failed append is lost, and that loss is what the gap record counts.
 */

import type { Dirent } from "node:fs";
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

import type { TelemetryCursor, TelemetryRecord, TelemetryResource } from "./telemetry.interface";
import { TELEMETRY_VERSION } from "./telemetry.interface";
import { boundBody, recordViolations } from "./telemetry.policy";

const SEGMENT_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const NEWLINE = 0x0a;

/** Evidence of loss: appended when writer startup terminates a torn fragment. */
export const GAP_RECORD_NAME = "score.telemetry.gap";

export type TelemetryAppendOutcome = "APPENDED" | "FAILED";

export interface TelemetryReadResult {
  readonly outcome: "OK" | "CURSOR_EXPIRED";
  readonly records: readonly TelemetryRecord[];
  readonly warnings: readonly string[];
  /** Where the next read resumes; unchanged on CURSOR_EXPIRED. */
  readonly cursor: TelemetryCursor;
}

export class TelemetryLogService {
  private recovered = false;

  constructor(
    private readonly dir: string,
    private readonly resource: TelemetryResource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * One write() of `line + "\n"` into the current UTC segment. FAILED on a
   * rejected record or any I/O error — never throws, no retry, no buffering.
   */
  append(record: TelemetryRecord): TelemetryAppendOutcome {
    try {
      if (recordViolations(record).length > 0) return "FAILED";
      // A record for another project would land in this project's segments
      // and misattribute telemetry to every reader — reject, never reroute.
      if (record.project !== this.resource.project) return "FAILED";
      // Gate first, truncate second (see boundBody): redaction saw the full
      // body above; only the stored copy is cut at the byte ceiling.
      if (record.body !== undefined) {
        const bounded = boundBody(record.body);
        if (bounded.truncated) record = { ...record, ...bounded };
      }
      if (!this.recovered) this.terminateFragment();
      appendFileSync(
        join(this.dir, `${dateStamp(this.now())}.jsonl`),
        `${JSON.stringify(record)}\n`,
      );
      return "APPENDED";
    } catch {
      return "FAILED";
    }
  }

  /** Oldest retained segment (or today when none exist), so a new reader sees every record once. */
  startCursor(): TelemetryCursor {
    return {
      project: this.resource.project,
      source: "telemetry",
      segment: this.listSegments()[0] ?? dateStamp(this.now()),
      byte_offset: 0,
    };
  }

  /**
   * Every complete line from the cursor forward, advancing across segments.
   * The incomplete tail is withheld entirely — its bytes stay ahead of the
   * returned cursor, so nothing is skipped or read twice.
   */
  read(cursor: TelemetryCursor): TelemetryReadResult {
    const segments = this.listSegments();
    const records: TelemetryRecord[] = [];
    const warnings: string[] = [];
    let segment = cursor.segment;
    let offset = cursor.byte_offset;
    for (;;) {
      const buffer = this.readSegmentFile(segment);
      if (buffer === undefined) {
        // Bytes already consumed from it, dated before the oldest retained
        // segment, or listed by this very call but gone by the read — in
        // every case retention deleted it: expire, never silently skip
        // records. Missing at offset 0 otherwise is just a date with no records.
        const oldest = segments[0];
        if (offset > 0 || segments.includes(segment) || (oldest !== undefined && segment < oldest))
          return { outcome: "CURSOR_EXPIRED", records: [], warnings: [], cursor };
      } else {
        // External actors only: an offset beyond file length or mid-line
        // yields data from the next complete line — no further validation.
        let start = Math.min(offset, buffer.length);
        if (start > 0 && buffer[start - 1] !== NEWLINE) {
          const resync = buffer.indexOf(NEWLINE, start);
          if (resync === -1) {
            offset = start;
            break;
          }
          start = resync + 1;
        }
        const pending = buffer.subarray(start);
        const lastNewline = pending.lastIndexOf(NEWLINE);
        if (lastNewline === -1) {
          // Incomplete tail: withheld until the writer completes or terminates it.
          offset = start;
          break;
        }
        for (const line of pending.subarray(0, lastNewline).toString("utf8").split("\n")) {
          this.parseLine(line, segment, records, warnings);
        }
        offset = start + lastNewline + 1;
        if (offset < buffer.length) break;
      }
      const next = segments.find((candidate) => candidate > segment);
      if (next === undefined) break;
      segment = next;
      offset = 0;
    }
    return {
      outcome: "OK",
      records,
      warnings,
      cursor: { ...cursor, segment, byte_offset: offset },
    };
  }

  /**
   * Deletes whole dated segments strictly older than `days`; a segment dated
   * exactly `days` ago survives — the same boundary as file-log.ts.
   */
  sweepRetention(days: number): void {
    const cutoff = dateStamp(new Date(this.now().getTime() - days * 86_400_000));
    for (const date of this.listSegments()) {
      if (date < cutoff) unlinkSync(join(this.dir, `${date}.jsonl`));
    }
  }

  /** Sorted ascending; segment names are UTC dates, so lexical order is time order. */
  private listSegments(): string[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => SEGMENT_FILE.exec(entry.name)?.[1])
      .filter((date): date is string => date !== undefined)
      .sort();
  }

  /** Readable means open() succeeds on a regular file — no other probing. */
  private readSegmentFile(date: string): Buffer | undefined {
    try {
      return readFileSync(join(this.dir, `${date}.jsonl`));
    } catch {
      return undefined;
    }
  }

  /** Reader tolerance: unknown fields ride along untouched; only `v` gates the line. */
  private parseLine(
    line: string,
    segment: string,
    records: TelemetryRecord[],
    warnings: string[],
  ): void {
    // A zero-byte line carries no record and no loss.
    if (line === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`unparseable line in ${segment}.jsonl`);
      return;
    }
    // Any non-object shape has no `v` and falls to the same warning.
    const version = (parsed as { v?: unknown } | null)?.v;
    if (version !== TELEMETRY_VERSION) {
      warnings.push(`unknown record version ${String(version)} in ${segment}.jsonl`);
      return;
    }
    records.push(parsed as TelemetryRecord);
  }

  /**
   * A restart after a mid-append death finds at most one unterminated
   * fragment at the tail of the newest segment. Terminate it — never parse,
   * salvage, or scan it — and record the loss as a gap record.
   */
  private terminateFragment(): void {
    mkdirSync(this.dir, { recursive: true });
    const newest = this.listSegments().at(-1);
    if (newest !== undefined) {
      const path = join(this.dir, `${newest}.jsonl`);
      const size = statSync(path).size;
      if (size > 0 && readByteAt(path, size - 1) !== NEWLINE) {
        const gap: TelemetryRecord = {
          v: TELEMETRY_VERSION,
          ts: this.now().toISOString(),
          signal: "event",
          name: GAP_RECORD_NAME,
          project: this.resource.project,
          attributes: { segment: newest },
        };
        // One write: the terminator and its gap evidence land together or
        // not at all — a death mid-recovery never leaves a cleanly
        // terminated fragment with the loss unrecorded.
        appendFileSync(path, `\n${JSON.stringify(gap)}\n`);
      }
    }
    // Only after success — a throw above leaves recovery pending, and the
    // next append retries it instead of concatenating onto the fragment.
    this.recovered = true;
  }
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
