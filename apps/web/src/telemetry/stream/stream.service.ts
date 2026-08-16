/**
 * One subscribe, end to end: parse the filter grammar, decode the presented
 * cursor, read the owners once for snapshots, capture the high-water marks,
 * then hand back a frame generator that replays to the marks, emits
 * `score.stream.caught_up`, and either closes (`follow=false`) or hands off
 * to the live follow half (#82) — shared tailers, heartbeats, bounded
 * buffers. All owner reads, the read-time stamp, and mark captures happen
 * in open(), before the first frame; the generator only reads segment bytes.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { JobStatus } from "@score/core/observation/jobs.service";
import { SupervisorJobsReader } from "@score/core/observation/jobs.service";
import type { TelemetrySource } from "@score/core/telemetry/telemetry.interface";
import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { scoreHome } from "@score/shared/config/layout";
import { loadConfig } from "@score/shared/config/load";
import type { ApiWarning, StreamEnvelope, WarningReason } from "../stream-envelope.interface";
import {
  CAUGHT_UP_EVENT,
  FLEET_SNAPSHOT_EVENT,
  HELLO_EVENT,
  LOG_RECORD_EVENT,
  PROJECT_SNAPSHOT_EVENT,
  TELEMETRY_RECORD_EVENTS,
  WARNING_EVENT,
} from "../stream-envelope.interface";
import { sseFrame } from "../stream-envelope.render";
import { decodeCursor, encodeCursor } from "./cursor.render";
import { FollowService } from "./follow/follow.service";
import { defaultTailerRegistry, type TailerRegistry } from "./follow/tailer.service";
import { parseStreamQuery, wantsSignal } from "./query.policy";
import { initialCursor, planReplay, watermarkFor } from "./replay.policy";
import { ReplayService } from "./replay.service";
import { fleetSnapshotData, projectSnapshotData } from "./snapshot.render";
import { SnapshotService } from "./snapshot.service";

export interface StreamDeps {
  readonly projectsDir: string;
  readonly readConfig: () => Promise<ScoreConfig | null>;
  readonly jobs: () => Promise<readonly JobStatus[] | null>;
  readonly now: () => Date;
  readonly streamId: () => string;
  readonly tailers: TailerRegistry;
}

export function defaultStreamDeps(): StreamDeps {
  return {
    projectsDir: join(scoreHome(), "projects"),
    // Absence is an empty fleet, not an unreadable one (readyz's same
    // boundary); only a present-but-unparseable config degrades with a warning.
    readConfig: async () => {
      try {
        return await loadConfig();
      } catch (error) {
        return (error as { code?: string }).code === "ENOENT" ? { version: 1, projects: {} } : null;
      }
    },
    // Read-only by construction: the observation seam exposes status alone,
    // so lifecycle verbs stay unreachable from this app (locked decision 6).
    jobs: () => new SupervisorJobsReader(new BunCommandRunner()).read(),
    now: () => new Date(),
    streamId: () => randomUUID(),
    tailers: defaultTailerRegistry,
  };
}

export type StreamOutcome =
  | { readonly kind: "error"; readonly status: 400 | 410; readonly reason: WarningReason }
  | {
      readonly kind: "stream";
      readonly frames: () => AsyncGenerator<string>;
      /** Cancellation hook: ends a parked follow wait now, not at the next wake. */
      readonly close: () => void;
    };

export class StreamService {
  constructor(private readonly deps: StreamDeps = defaultStreamDeps()) {}

  async open(params: URLSearchParams, lastEventId: string | null): Promise<StreamOutcome> {
    const parsed = parseStreamQuery(params);
    if (!parsed.ok) return { kind: "error", status: 400, reason: parsed.reason };
    const query = parsed.query;

    let cursorComponents: ReturnType<typeof decodeCursor>;
    if (lastEventId !== null) {
      cursorComponents = decodeCursor(lastEventId);
      if (cursorComponents === undefined) {
        return { kind: "error", status: 400, reason: "CURSOR_UNPARSEABLE" };
      }
    }

    // One read time for the whole subscribe: snapshots are stamped with the
    // moment the owners were read, not the moment a consumer pulls a frame.
    const readTime = this.deps.now();
    const observation = await new SnapshotService(this.deps).observe(readTime.getTime());
    const selectedKeys =
      query.projects === undefined
        ? observation.keys
        : observation.keys.filter((key) => query.projects?.includes(key));

    const sources: TelemetrySource[] = [];
    if (["event", "span", "metric"].some((signal) => wantsSignal(query, signal as "event"))) {
      sources.push("telemetry");
    }
    if (wantsSignal(query, "log")) sources.push("log");

    const replayService = new ReplayService(this.deps.projectsDir);
    const marks = replayService.captureMarks(selectedKeys, sources);
    const plan = planReplay(marks, cursorComponents);
    if (!plan.ok) return { kind: "error", status: 410, reason: plan.reason };
    const pairs = plan.pairs;

    const streamId = this.deps.streamId();
    const emittedAt = readTime.toISOString();
    const followService = new FollowService(this.deps);
    let components = initialCursor(pairs);
    let cursor = encodeCursor(components);
    const wrap = <T>(data: T, warnings?: readonly ApiWarning[]): StreamEnvelope<T> => ({
      api_version: "v1",
      emitted_at: emittedAt,
      stream_id: streamId,
      cursor,
      data,
      ...(warnings !== undefined && { warnings }),
    });

    // Owner-read failures ride on the snapshots they degrade, explicitly —
    // an unknown job table or membership must never pose as a complete one.
    const observationWarnings: ApiWarning[] = [
      ...(observation.configReadable ? [] : [{ reason: "CONFIG_UNPARSEABLE" as const }]),
      ...(observation.jobsReadable ? [] : [{ reason: "SUPERVISOR_UNREADABLE" as const }]),
    ];
    const selectedProjects = observation.projects.filter((project) =>
      selectedKeys.includes(project.key),
    );

    async function* frames(): AsyncGenerator<string> {
      const degraded = observationWarnings.length > 0 ? observationWarnings : undefined;
      yield sseFrame(HELLO_EVENT, wrap({}), cursor);
      if (wantsSignal(query, "snapshot")) {
        yield sseFrame(
          FLEET_SNAPSHOT_EVENT,
          wrap(fleetSnapshotData({ ...observation, projects: selectedProjects }), degraded),
          cursor,
        );
        for (const project of selectedProjects) {
          yield sseFrame(
            PROJECT_SNAPSHOT_EVENT,
            wrap(projectSnapshotData(project, watermarkFor(marks, project.key)), degraded),
            cursor,
          );
        }
      }
      // Manual iteration: the generator's return value is the final
      // composite cursor — filtered records advanced it past the last
      // emitted frame, and caught_up must carry the true resting position.
      const replaying = replayService.replay(pairs, query);
      let sawUnreadable = false;
      for (;;) {
        const step = replaying.next();
        if (step.done) {
          components = step.value;
          cursor = encodeCursor(components);
          break;
        }
        const emission = step.value;
        components = emission.cursor;
        cursor = encodeCursor(components);
        if (emission.kind === "warning") {
          sawUnreadable ||= emission.reason === "SEGMENT_UNREADABLE";
          yield sseFrame(WARNING_EVENT, wrap(null, [{ reason: emission.reason }]), cursor);
        } else if (emission.kind === "telemetry") {
          yield sseFrame(
            TELEMETRY_RECORD_EVENTS[emission.record.signal],
            wrap(emission.record),
            cursor,
          );
        } else {
          yield sseFrame(LOG_RECORD_EVENT, wrap(emission.record), cursor);
        }
      }
      yield sseFrame(CAUGHT_UP_EVENT, wrap({}), cursor);
      // The live half (#82): the stream stays open past caught_up, fed by
      // the shared tailers, until the client disconnects or is disconnected.
      // A segment retention deleted mid-replay already carried its one
      // warning; handing off would only re-plan against the gone segment
      // and warn a second time — close cleanly instead, the client resumes
      // from an explicit time bound.
      if (query.follow && !sawUnreadable) {
        yield* followService.follow({
          streamId,
          query,
          projects: selectedKeys,
          sources,
          start: components,
        });
      }
    }

    return { kind: "stream", frames, close: () => followService.close() };
  }
}
