/**
 * One subscribe, end to end: parse the filter grammar, decode the presented
 * cursor, read the owners once for snapshots, capture the high-water marks,
 * then hand back a frame generator that replays to the marks, emits
 * `score.stream.caught_up`, and closes — `follow=true` gets the
 * FOLLOW_NOT_IMPLEMENTED warning seam (#82) instead of a hang. All owner
 * reads and mark captures happen here, before the first frame; the
 * generator only reads segment bytes.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { JobStatus } from "@score/core/observation/jobs.service";
import { readSupervisorJobs } from "@score/core/observation/jobs.service";
import type { TelemetrySource } from "@score/core/telemetry/telemetry.interface";
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
import { parseStreamQuery, wantsSignal } from "./query.policy";
import { captureMarks, initialCursor, planReplay, replay, watermarkFor } from "./replay.service";
import { fleetSnapshotData, observeFleet, projectSnapshotData } from "./snapshot.service";

export interface StreamDeps {
  readonly projectsDir: string;
  readonly readConfig: () => Promise<ScoreConfig | null>;
  readonly jobs: () => Promise<readonly JobStatus[]>;
  readonly now: () => Date;
  readonly streamId: () => string;
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
    jobs: readSupervisorJobs,
    now: () => new Date(),
    streamId: () => randomUUID(),
  };
}

export type StreamOutcome =
  | { readonly kind: "error"; readonly status: 400 | 410; readonly reason: WarningReason }
  | { readonly kind: "stream"; readonly frames: () => Generator<string> };

export async function openStream(
  params: URLSearchParams,
  lastEventId: string | null,
  deps: StreamDeps = defaultStreamDeps(),
): Promise<StreamOutcome> {
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

  const observation = await observeFleet(deps, deps.now().getTime());
  const selectedKeys =
    query.projects === undefined
      ? observation.keys
      : observation.keys.filter((key) => query.projects?.includes(key));

  const sources: TelemetrySource[] = [];
  if (["event", "span", "metric"].some((signal) => wantsSignal(query, signal as "event"))) {
    sources.push("telemetry");
  }
  if (wantsSignal(query, "log")) sources.push("log");

  const marks = captureMarks(deps.projectsDir, selectedKeys, sources);
  const plan = planReplay(marks, cursorComponents);
  if (!plan.ok) return { kind: "error", status: 410, reason: plan.reason };

  const streamId = deps.streamId();
  let cursor = encodeCursor(initialCursor(plan.pairs));
  const wrap = <T>(data: T, warnings?: readonly ApiWarning[]): StreamEnvelope<T> => ({
    api_version: "v1",
    emitted_at: deps.now().toISOString(),
    stream_id: streamId,
    cursor,
    data,
    ...(warnings !== undefined && { warnings }),
  });

  const selectedProjects = observation.projects.filter((project) =>
    selectedKeys.includes(project.key),
  );
  const { projectsDir } = deps;

  function* frames(): Generator<string> {
    yield sseFrame(HELLO_EVENT, wrap({}), cursor);
    if (wantsSignal(query, "snapshot")) {
      yield sseFrame(
        FLEET_SNAPSHOT_EVENT,
        wrap(
          fleetSnapshotData({ ...observation, projects: selectedProjects }),
          // An unreadable config.jsonc degrades membership; say so instead
          // of presenting the reduced fleet as complete.
          observation.configReadable ? undefined : [{ reason: "CONFIG_UNPARSEABLE" }],
        ),
        cursor,
      );
      for (const project of selectedProjects) {
        yield sseFrame(
          PROJECT_SNAPSHOT_EVENT,
          wrap(projectSnapshotData(project, watermarkFor(marks, project.key))),
          cursor,
        );
      }
    }
    for (const emission of replay(projectsDir, plan.ok ? plan.pairs : [], query)) {
      cursor = encodeCursor(emission.cursor);
      if (emission.kind === "warning") {
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
    // The #82 seam: an explicit, tested close instead of a silent hang.
    if (query.follow) {
      yield sseFrame(WARNING_EVENT, wrap(null, [{ reason: "FOLLOW_NOT_IMPLEMENTED" }]), cursor);
    }
  }

  return { kind: "stream", frames };
}
