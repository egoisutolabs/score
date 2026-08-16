/**
 * Filtered historical replay to a fixed high-water mark (#81): each selected
 * file's byte length is captured once at subscribe, batches of at most
 * REPLAY_BATCH_LIMIT records per I/O cycle continue until every mark is
 * reached, and emitting fewer records than the mark holds is always named by
 * a warning. The marks are never re-captured, so replay terminates under
 * continuous writes by construction. Read-only consumer of the #77 segment
 * layout — this service never writes, repairs, or reconciles a file.
 * Planning decisions live in replay.policy.ts.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  TelemetryCursor,
  TelemetryRecord,
  TelemetrySource,
} from "@score/core/telemetry/telemetry.interface";
import { TELEMETRY_VERSION } from "@score/core/telemetry/telemetry.interface";
import type { WarningReason } from "../stream-envelope.interface";
import type { StreamLogRecord, StreamQuery } from "./query.policy";
import { matchesLog, matchesTelemetry } from "./query.policy";
import type { PairMarks, PairPlan, SegmentMark } from "./replay.policy";

/** The batch ceiling is a constant by definition (#81). */
export const REPLAY_BATCH_LIMIT = 500;

/** Bytes per positional read; grown only when one record outspans it. */
const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

const SOURCE_LAYOUT: Record<
  TelemetrySource,
  { readonly dir: string; readonly file: RegExp; readonly extension: string }
> = {
  telemetry: { dir: "telemetry", file: /^(\d{4}-\d{2}-\d{2})\.jsonl$/, extension: ".jsonl" },
  log: { dir: "logs", file: /^(\d{4}-\d{2}-\d{2})\.log$/, extension: ".log" },
};

export type ReplayEmission =
  | {
      readonly kind: "telemetry";
      readonly record: TelemetryRecord;
      readonly cursor: readonly TelemetryCursor[];
    }
  | {
      readonly kind: "log";
      readonly record: StreamLogRecord;
      readonly cursor: readonly TelemetryCursor[];
    }
  | {
      readonly kind: "warning";
      readonly reason: WarningReason;
      readonly cursor: readonly TelemetryCursor[];
    };

export class ReplayService {
  constructor(private readonly projectsDir: string) {}

  /**
   * One stat pass over every selected project/source at subscribe time. A
   * file that appears after this call is beyond the mark by definition.
   */
  captureMarks(keys: readonly string[], sources: readonly TelemetrySource[]): readonly PairMarks[] {
    const pairs: PairMarks[] = [];
    for (const project of keys) {
      for (const source of sources) {
        const layout = SOURCE_LAYOUT[source];
        const dir = join(this.projectsDir, project, layout.dir);
        let names: readonly string[];
        try {
          names = readdirSync(dir);
        } catch {
          names = [];
        }
        const segments: SegmentMark[] = [];
        for (const name of [...names].sort()) {
          const segment = layout.file.exec(name)?.[1];
          if (segment === undefined) continue;
          try {
            segments.push({ segment, mark: statSync(join(dir, name)).size });
          } catch {
            // Deleted between readdir and stat — beyond reach, same as absent.
          }
        }
        pairs.push({ project, source, segments });
      }
    }
    return pairs;
  }

  /**
   * Replays every planned pair sequentially to its captured marks and
   * returns the final composite cursor — filtered records advance it too,
   * so caught_up carries the true resting position, not the last emitted
   * one. Unreadable segments and unparseable lines advance it with one
   * warning per segment per cause, so a shortfall against the mark is never
   * silent.
   */
  *replay(
    pairs: readonly PairPlan[],
    query: StreamQuery,
  ): Generator<ReplayEmission, readonly TelemetryCursor[]> {
    // Live positions, one slot per positioned pair, mutated as replay walks.
    const positions = new Map<PairPlan, TelemetryCursor>();
    for (const pair of pairs) {
      if (pair.position !== undefined) positions.set(pair, pair.position);
    }
    const composite = (): readonly TelemetryCursor[] =>
      pairs
        .map((pair) => positions.get(pair))
        .filter((position): position is TelemetryCursor => position !== undefined);

    for (const pair of pairs) {
      const layout = SOURCE_LAYOUT[pair.source];
      let stalled = false;
      for (const segment of pair.segments) {
        const path = join(
          this.projectsDir,
          pair.project,
          layout.dir,
          `${segment.segment}${layout.extension}`,
        );
        const warned = new Set<WarningReason>();
        const warn = function* (this: void, reason: WarningReason): Generator<ReplayEmission> {
          if (warned.has(reason)) return;
          warned.add(reason);
          yield { kind: "warning", reason, cursor: composite() };
        };
        const advance = (offset: number): void => {
          positions.set(pair, {
            project: pair.project,
            source: pair.source,
            segment: segment.segment,
            byte_offset: offset,
          });
        };
        let offset = segment.start;
        advance(offset);
        // A presented offset can land mid-line; the fragment ahead belongs to
        // a record whose start was already consumed — drop to the next line.
        let resync = offset > 0 && byteBefore(path, offset) !== NEWLINE;
        while (offset < segment.mark) {
          const cycle = readCycle(path, offset, segment.mark);
          if (cycle === "UNREADABLE") {
            // Retention removed the file mid-replay: the mark can no longer
            // be honored — name the shortfall and move on.
            yield* warn("SEGMENT_UNREADABLE");
            advance(segment.mark);
            break;
          }
          if (cycle.lines.length === 0) {
            // No complete line before the mark: the remainder was an
            // in-progress record at capture — withheld, cursor stays put.
            // Later segments must not run ahead of it (#82 rotation order):
            // the writer completes the line before rolling, so a follow
            // scan clears the stall on its next wake.
            stalled = true;
            break;
          }
          for (const line of cycle.lines) {
            if (resync) {
              resync = false;
              advance(line.end);
              continue;
            }
            const emission = parseLine(pair, line.text);
            advance(line.end);
            if (emission === "UNPARSEABLE") {
              yield* warn("RECORD_UNPARSEABLE");
              continue;
            }
            if (emission.kind === "telemetry" && matchesTelemetry(query, emission.record)) {
              yield { kind: "telemetry", record: emission.record, cursor: composite() };
            } else if (emission.kind === "log" && matchesLog(query, emission.record)) {
              yield { kind: "log", record: emission.record, cursor: composite() };
            }
          }
          offset = cycle.lines[cycle.lines.length - 1]?.end ?? offset;
        }
        if (stalled) break;
      }
    }
    return composite();
  }
}

/** Human log lines are `[RFC3339] [level] text` — file-log.ts's exact shape. */
const LOG_LINE = /^\[([^\]]+)\] \[([a-z]+)\] (.*)$/;

function parseLine(
  pair: PairPlan,
  text: string,
):
  | { kind: "telemetry"; record: TelemetryRecord }
  | { kind: "log"; record: StreamLogRecord }
  | "UNPARSEABLE" {
  if (pair.source === "log") {
    const match = LOG_LINE.exec(text);
    if (match === null) return "UNPARSEABLE";
    return {
      kind: "log",
      record: {
        project: pair.project,
        ts: match[1] as string,
        level: match[2] as string,
        body: match[3] as string,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "UNPARSEABLE";
  }
  // Reader tolerance mirrors the #77 reader: only `v` gates the line; an
  // unknown version surfaces as a warning, never a crash.
  if ((parsed as { v?: unknown } | null)?.v !== TELEMETRY_VERSION) return "UNPARSEABLE";
  return { kind: "telemetry", record: parsed as TelemetryRecord };
}

export interface CycleLine {
  readonly text: string;
  /** Absolute byte offset just past this line's newline. */
  readonly end: number;
}

export interface Cycle {
  readonly lines: readonly CycleLine[];
}

/**
 * One I/O cycle: a positional read from `offset`, capped at the mark,
 * yielding at most REPLAY_BATCH_LIMIT complete lines. The chunk doubles only
 * while a single record outspans it, so memory stays bounded by the longest
 * line, which the writers already bound. Exported so the batch ceiling is
 * provable directly — replay output alone cannot show the per-cycle cap.
 */
export function readCycle(path: string, offset: number, mark: number): Cycle | "UNREADABLE" {
  let capacity = READ_CHUNK_BYTES;
  for (;;) {
    const want = Math.min(capacity, mark - offset);
    let view: Buffer;
    try {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(want);
        view = buffer.subarray(0, readSync(fd, buffer, 0, want, offset));
      } finally {
        closeSync(fd);
      }
    } catch {
      return "UNREADABLE";
    }
    const lastNewline = view.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      // Shorter reads cannot hide a newline: the bytes end before the mark
      // (truncated file) or the mark cuts a record — either way no complete
      // line remains in this segment.
      if (want >= mark - offset || view.length < want) return { lines: [] };
      capacity *= 2;
      continue;
    }
    const lines: CycleLine[] = [];
    let cursor = 0;
    while (cursor <= lastNewline && lines.length < REPLAY_BATCH_LIMIT) {
      const newline = view.indexOf(NEWLINE, cursor);
      lines.push({
        text: view.subarray(cursor, newline).toString("utf8"),
        end: offset + newline + 1,
      });
      cursor = newline + 1;
    }
    return { lines };
  }
}

function byteBefore(path: string, offset: number): number {
  try {
    const fd = openSync(path, "r");
    try {
      const byte = Buffer.alloc(1);
      readSync(fd, byte, 0, 1, offset - 1);
      return byte[0] ?? NEWLINE;
    } finally {
      closeSync(fd);
    }
  } catch {
    return NEWLINE;
  }
}
