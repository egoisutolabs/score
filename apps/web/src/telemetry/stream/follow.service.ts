/**
 * The live half of a subscription (#82): after caught_up, the shared
 * per-project tailers wake this service, and each wake re-plans from the
 * subscriber's own composite cursor and replays the delta — exact resume
 * falls out of the same planReplay/replay machinery the historical half
 * uses, independently per project/source pair. Idle 15s windows carry an
 * SSE comment heartbeat; a subscriber whose outbound queue would exceed
 * FOLLOW_QUEUE_LIMIT envelopes is disconnected (its client resumes from
 * the last frame actually written); a segment the cursor still names
 * disappearing mid-follow yields one warning and a clean close.
 */

import { join } from "node:path";
import type { TelemetryCursor, TelemetrySource } from "@score/core/telemetry/telemetry.interface";
import type { ApiWarning, StreamEnvelope } from "../stream-envelope.interface";
import {
  LOG_RECORD_EVENT,
  TELEMETRY_RECORD_EVENTS,
  WARNING_EVENT,
} from "../stream-envelope.interface";
import { sseFrame } from "../stream-envelope.render";
import { encodeCursor } from "./cursor.render";
import type { StreamQuery } from "./query.policy";
import { planReplay } from "./replay.policy";
import { ReplayService } from "./replay.service";
import type { TailerRegistry } from "./tailer.service";

/** Heartbeat cadence and queue bound — constant ceilings by definition (#82). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const FOLLOW_QUEUE_LIMIT = 1024;
/** The idle keepalive: an SSE comment, not an envelope — no cursor to corrupt. */
export const HEARTBEAT_FRAME = ":hb\n\n";

export interface FollowDeps {
  readonly projectsDir: string;
  readonly now: () => Date;
  readonly tailers: TailerRegistry;
}

export interface FollowParams {
  readonly streamId: string;
  readonly query: StreamQuery;
  readonly projects: readonly string[];
  readonly sources: readonly TelemetrySource[];
  /** The composite cursor at caught_up — follow's starting position. */
  readonly start: readonly TelemetryCursor[];
}

export class FollowService {
  constructor(private readonly deps: FollowDeps) {}

  async *follow(params: FollowParams): AsyncGenerator<string> {
    const replayService = new ReplayService(this.deps.projectsDir);
    let components = params.start;
    const queue: string[] = [];
    let overflowed = false;
    let closing = false;
    let wakeLoop: () => void = () => {};

    const frameFor = (event: string, data: unknown, warnings?: readonly ApiWarning[]): string => {
      const cursor = encodeCursor(components);
      const envelope: StreamEnvelope<unknown> = {
        api_version: "v1",
        emitted_at: this.deps.now().toISOString(),
        stream_id: params.streamId,
        cursor,
        data,
        ...(warnings !== undefined && { warnings }),
      };
      return sseFrame(event, envelope, cursor);
    };

    const enqueue = (frame: string): boolean => {
      // The 1025th queued envelope disconnects this subscriber. Nothing
      // queued is owed to it: the client resumes exactly from the last
      // frame actually written, which is the only cursor it ever saw.
      if (queue.length >= FOLLOW_QUEUE_LIMIT) {
        overflowed = true;
        return false;
      }
      queue.push(frame);
      return true;
    };

    // One scan: re-plan from the subscriber's own cursor and replay the
    // delta. Fully synchronous, so a tailer wake never interleaves with a
    // scan in progress, and rotation order rides on replay's segment walk.
    const scan = (): void => {
      if (overflowed || closing) return;
      const plan = planReplay(replayService.captureMarks(params.projects, params.sources), components);
      if (!plan.ok) {
        // Retention deleted a segment the cursor still names: the position
        // is unrecoverable — one warning, then a clean close. The client
        // resumes from an explicit time bound, not from this cursor.
        enqueue(frameFor(WARNING_EVENT, null, [{ reason: "SEGMENT_UNREADABLE" }]));
        closing = true;
        wakeLoop();
        return;
      }
      const replaying = replayService.replay(plan.pairs, params.query);
      for (;;) {
        const step = replaying.next();
        if (step.done) {
          components = step.value;
          break;
        }
        const emission = step.value;
        components = emission.cursor;
        const delivered =
          emission.kind === "warning"
            ? enqueue(frameFor(WARNING_EVENT, null, [{ reason: emission.reason }]))
            : emission.kind === "telemetry"
              ? enqueue(frameFor(TELEMETRY_RECORD_EVENTS[emission.record.signal], emission.record))
              : enqueue(frameFor(LOG_RECORD_EVENT, emission.record));
        if (!delivered) break;
      }
      wakeLoop();
    };

    const releases = params.projects.map((project) =>
      this.deps.tailers.acquire(join(this.deps.projectsDir, project), scan),
    );
    try {
      // Covers appends between the replay's captured marks and the attach
      // above; everything later wakes through the tailer.
      scan();
      for (;;) {
        if (overflowed) return;
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closing) return;
        const woke = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), HEARTBEAT_INTERVAL_MS);
          wakeLoop = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        if (!woke) yield HEARTBEAT_FRAME;
      }
    } finally {
      for (const release of releases) release();
    }
  }
}
