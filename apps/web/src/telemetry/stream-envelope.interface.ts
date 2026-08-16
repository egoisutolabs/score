/**
 * The v1 stream envelope (#83's SSE contract): every payload the API emits —
 * SSE frames and probe error bodies alike — travels inside this versioned
 * shape. Within v1 it evolves additively only. Types only; shaping lives in
 * stream-envelope.render.ts.
 */

/** SSE event name of the handshake frame, always the stream's first. */
export const HELLO_EVENT = "score.stream.hello";
/** Subscribe-time fleet membership and per-project health. */
export const FLEET_SNAPSHOT_EVENT = "score.snapshot.fleet";
/** Subscribe-time single-project observation: config, status, health reasons, watermark. */
export const PROJECT_SNAPSHOT_EVENT = "score.snapshot.project";
/** One correlated dated-log line. */
export const LOG_RECORD_EVENT = "score.log.record";
/** Replay boundary: every durable record up to the captured mark was sent. */
export const CAUGHT_UP_EVENT = "score.stream.caught_up";
/** Carries a WarningReason envelope; also the follow seam's frame (#82). */
export const WARNING_EVENT = "score.stream.warning";

/** SSE event per stored telemetry signal. */
export const TELEMETRY_RECORD_EVENTS = {
  event: "score.telemetry.event",
  span: "score.telemetry.span",
  metric: "score.telemetry.metric",
} as const;

/**
 * The whole safe-error vocabulary: a reason from this union is everything an
 * error response says. Paths, environment values, stack traces, and raw
 * command output are never present.
 */
export type WarningReason =
  | "CONFIG_UNPARSEABLE"
  | "SEGMENT_UNREADABLE"
  | "FILTER_UNKNOWN"
  | "FILTER_INVALID"
  | "CURSOR_UNPARSEABLE"
  | "CURSOR_EXPIRED"
  | "RECORD_UNPARSEABLE"
  | "FOLLOW_NOT_IMPLEMENTED";

export interface ApiWarning {
  readonly reason: WarningReason;
}

export interface StreamEnvelope<T> {
  readonly api_version: "v1";
  /** RFC 3339 timestamp. */
  readonly emitted_at: string;
  readonly stream_id: string;
  /** Opaque resume position; encoding is #81 scope. */
  readonly cursor: string;
  readonly data: T;
  readonly warnings?: readonly ApiWarning[];
}
