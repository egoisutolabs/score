import type {
  FleetCursor,
  TelemetryRecord,
  TelemetrySource,
} from "@score/core/telemetry/telemetry.interface";

/**
 * The v1 SSE stream vocabulary. Event names and envelope shape are the wire
 * contract — they evolve additively only, exactly like the record vocabulary
 * they carry. Metric and log payloads have no record vocabulary yet (#53);
 * their event names are reserved here so the wire never renames them.
 */
export const STREAM_VERSION = 1;

export type StreamEventName =
  | "score.snapshot.project"
  | "score.telemetry.span"
  | "score.telemetry.event"
  | "score.telemetry.metric"
  | "score.telemetry.log"
  | "score.stream.caught_up"
  | "score.stream.error";

/**
 * Per-stream sequence counters keyed by stream scope (a project, the fleet).
 * The only state a reconnecting client needs; carried on the SSE `id:` line.
 */
export type StreamSequence = Readonly<Record<string, number>>;

/** One SSE frame: an event name, its JSON payload, and an optional resume id. */
interface EnvelopeBase {
  readonly sequence?: StreamSequence;
}

/**
 * A discriminated union on `event`: every event name admits exactly its own
 * payload shape, so a mismatched pair (an error name over snapshot data, a
 * reserved metric/log name over any payload — v1 has no vocabulary for
 * either) is a compile-time error, not a frame renderEnvelope would emit
 * and parseEnvelope would reject.
 */
export type StreamEnvelope =
  | SnapshotEnvelope
  | SpanEnvelope
  | EventEnvelope
  | CaughtUpEnvelope
  | ErrorEnvelope;

export interface SnapshotEnvelope extends EnvelopeBase {
  readonly event: "score.snapshot.project";
  readonly data: SnapshotProjectData;
}

export interface SpanEnvelope extends EnvelopeBase {
  readonly event: "score.telemetry.span";
  readonly data: TelemetryRecordData<"span">;
}

export interface EventEnvelope extends EnvelopeBase {
  readonly event: "score.telemetry.event";
  readonly data: TelemetryRecordData<"event">;
}

export interface CaughtUpEnvelope extends EnvelopeBase {
  readonly event: "score.stream.caught_up";
  readonly data: CaughtUpData;
}

export interface ErrorEnvelope extends EnvelopeBase {
  readonly event: "score.stream.error";
  readonly data: StreamErrorData;
}

/** Snapshot of one project's observed health — the first thing a client sees. */
export interface SnapshotProjectData {
  readonly project: string;
  readonly health: string;
  readonly observed_at: string;
}

/**
 * A replayed or live record, tagged with the source it was read from. The
 * kind parameter couples a record to its event name — a span frame carries
 * a TelemetrySpan, an event frame a TelemetryEvent, at the type level too.
 */
export interface TelemetryRecordData<
  Kind extends TelemetryRecord["kind"] = TelemetryRecord["kind"],
> {
  readonly source: TelemetrySource;
  readonly record: Extract<TelemetryRecord, { readonly kind: Kind }>;
}

/** Emitted once replay ends; `through` is the fleet cursor follow resumes from. */
export interface CaughtUpData {
  readonly through: FleetCursor;
  readonly follow: true;
}

/** Safe error rendering: a closed set of reason codes, never internals. */
export type StreamErrorCode = "cursor-expired" | "not-ready" | "internal";

export interface StreamErrorData {
  readonly reason_code: StreamErrorCode;
}

export type StreamEventData =
  | SnapshotProjectData
  | TelemetryRecordData
  | CaughtUpData
  | StreamErrorData;
