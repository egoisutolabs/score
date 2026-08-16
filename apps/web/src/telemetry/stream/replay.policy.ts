/**
 * Pure replay planning (#81): given the marks captured at subscribe and an
 * optionally presented cursor, decide where each project/source pair starts,
 * which cursors expired, and what the composite watermark looks like. All
 * I/O — capturing the marks and walking the bytes — lives in
 * replay.service.ts.
 */

import type { TelemetryCursor, TelemetrySource } from "@score/core/telemetry/telemetry.interface";

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
 * all; replay for that pair is empty, not expired — the same boundary as
 * TelemetryLogService.read, where an offset-zero date with no retained
 * evidence around it is indistinguishable from a date that never had records.
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
          position: {
            project: pair.project,
            source: pair.source,
            segment: segments[0].segment,
            byte_offset: 0,
          },
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

/** The composite cursor before any record: every positioned pair at its start. */
export function initialCursor(pairs: readonly PairPlan[]): readonly TelemetryCursor[] {
  return pairs
    .map((pair) => pair.position)
    .filter((position): position is TelemetryCursor => position !== undefined);
}
