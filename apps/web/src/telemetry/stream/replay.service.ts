/**
 * Filtered historical replay to a fixed high-water mark (#81): each selected
 * file's byte length is captured once at subscribe, batches of at most
 * REPLAY_BATCH_LIMIT records per I/O cycle continue until every mark is
 * reached, and emitting fewer records than the mark holds is always named by
 * a warning. The marks are never re-captured, so replay terminates under
 * continuous writes by construction. Read-only consumer of the #77 segment
 * layout — this module never writes, repairs, or reconciles a file.
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

/** The batch ceiling is a constant by definition (#81). */
export const REPLAY_BATCH_LIMIT = 500;

/** Bytes per positional read; grown only when one record outspans it. */
const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

const SOURCE_LAYOUT: Record<TelemetrySource, { readonly dir: string; readonly file: RegExp }> = {
  telemetry: { dir: "telemetry", file: /^(\d{4}-\d{2}-\d{2})\.jsonl$/ },
  log: { dir: "logs", file: /^(\d{4}-\d{2}-\d{2})\.log$/ },
};

export interface SegmentMark {
  readonly segment: string;
  /** Byte length at subscribe — the fixed high-water mark. */
  readonly mark: number;
}

export interface PairMarks {
  readonly project: string;
  readonly source: TelemetrySource;
  /** Ascending by date; segment names are UTC dates, so lexical order is time order. */
  readonly segments: readonly SegmentMark[];
}

/**
 * One stat pass over every selected project/source at subscribe time. A
 * file that appears after this call is beyond the mark by definition.
 */
export function captureMarks(
  projectsDir: string,
  keys: readonly string[],
  sources: readonly TelemetrySource[],
): readonly PairMarks[] {
  const pairs: PairMarks[] = [];
  for (const project of keys) {
    for (const source of sources) {
      const layout = SOURCE_LAYOUT[source];
      const dir = join(projectsDir, project, layout.dir);
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

/** One project's high-water positions: newest segment + captured mark per source. */
export function watermarkFor(
  pairs: readonly PairMarks[],
  project: string,
): readonly TelemetryCursor[] {
  return pairs
    .filter((pair) => pair.project === project && pair.segments.length > 0)
    .map((pair) => {
      const newest = pair.segments[pair.segments.length - 1] as SegmentMark;
      return {
        project,
        source: pair.source,
        segment: newest.segment,
        byte_offset: newest.mark,
      };
    });
}

export interface SegmentPlan extends SegmentMark {
  readonly start: number;
}

export interface PairPlan {
  readonly project: string;
  readonly source: TelemetrySource;
  readonly segments: readonly SegmentPlan[];
  /** Absent when the pair has no files and no presented position. */
  readonly position?: TelemetryCursor;
}

export type ReplayPlan =
  | { readonly ok: true; readonly pairs: readonly PairPlan[] }
  | { readonly ok: false; readonly reason: "CURSOR_EXPIRED" };

/**
 * Positions each pair from a presented cursor component, or at its first
 * segment. A component naming a segment that is gone — bytes already
 * consumed from it, or dated before a retained segment — was deleted by
 * retention: the whole subscribe expires (410) before any event, never a
 * silent skip. A component dated after every retained segment consumed them
 * all; replay for that pair is empty, not expired.
 */
export function planReplay(
  pairs: readonly PairMarks[],
  cursor: readonly TelemetryCursor[] | undefined,
): ReplayPlan {
  const plans: PairPlan[] = [];
  for (const pair of pairs) {
    const component = cursor?.find(
      (candidate) => candidate.project === pair.project && candidate.source === pair.source,
    );
    if (component === undefined) {
      const segments = pair.segments.map((segment) => ({ ...segment, start: 0 }));
      plans.push({
        project: pair.project,
        source: pair.source,
        segments,
        ...(segments[0] && {
          position: cursorAt(pair, segments[0].segment, 0),
        }),
      });
      continue;
    }
    const named = pair.segments.find((segment) => segment.segment === component.segment);
    if (named === undefined) {
      if (
        component.byte_offset > 0 ||
        pair.segments.some((segment) => segment.segment > component.segment)
      ) {
        return { ok: false, reason: "CURSOR_EXPIRED" };
      }
      // Every retained segment predates the component: already consumed.
      plans.push({ project: pair.project, source: pair.source, segments: [], position: component });
      continue;
    }
    const segments = pair.segments
      .filter((segment) => segment.segment >= component.segment)
      .map((segment) => ({
        ...segment,
        start: segment.segment === component.segment ? component.byte_offset : 0,
      }));
    plans.push({ project: pair.project, source: pair.source, segments, position: component });
  }
  return { ok: true, pairs: plans };
}

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

/** The composite cursor before any record: every positioned pair at its start. */
export function initialCursor(pairs: readonly PairPlan[]): readonly TelemetryCursor[] {
  return pairs
    .map((pair) => pair.position)
    .filter((position): position is TelemetryCursor => position !== undefined);
}

/**
 * Replays every selected pair sequentially to its captured marks. Filtered
 * records advance the cursor without a frame; unreadable segments and
 * unparseable lines advance it with one warning per segment per cause, so a
 * shortfall against the mark is never silent.
 */
export function* replay(
  projectsDir: string,
  pairs: readonly PairPlan[],
  query: StreamQuery,
): Generator<ReplayEmission> {
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
    for (const segment of pair.segments) {
      const extension = pair.source === "telemetry" ? ".jsonl" : ".log";
      const realPath = join(
        projectsDir,
        pair.project,
        layout.dir,
        `${segment.segment}${extension}`,
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
      let resync = offset > 0 && byteBefore(realPath, offset) !== NEWLINE;
      while (offset < segment.mark) {
        const cycle = readCycle(realPath, offset, segment.mark);
        if (cycle === "UNREADABLE") {
          // Retention removed the file mid-replay: the mark can no longer be
          // honored — name the shortfall and move on.
          yield* warn("SEGMENT_UNREADABLE");
          advance(segment.mark);
          break;
        }
        if (cycle.lines.length === 0) {
          // No complete line before the mark: the remainder was an
          // in-progress record at capture — withheld, cursor stays put.
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
    }
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

interface CycleLine {
  readonly text: string;
  /** Absolute byte offset just past this line's newline. */
  readonly end: number;
}

interface Cycle {
  readonly lines: readonly CycleLine[];
}

/**
 * One I/O cycle: a positional read from `offset`, capped at the mark,
 * yielding at most REPLAY_BATCH_LIMIT complete lines. The chunk doubles only
 * while a single record outspans it, so memory stays bounded by the longest
 * line, which the writers already bound.
 */
function readCycle(path: string, offset: number, mark: number): Cycle | "UNREADABLE" {
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

function cursorAt(pair: PairMarks, segment: string, byteOffset: number): TelemetryCursor {
  return { project: pair.project, source: pair.source, segment, byte_offset: byteOffset };
}
