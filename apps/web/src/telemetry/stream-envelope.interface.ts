/**
 * The v1 stream envelope (#83's SSE contract): every payload the API emits —
 * SSE frames and probe error bodies alike — travels inside this versioned
 * shape. Within v1 it evolves additively only. Types only; shaping lives in
 * stream-envelope.render.ts.
 */

/** SSE event name of the handshake's single frame. */
export const HELLO_EVENT = "score.stream.hello";

/**
 * The whole safe-error vocabulary: a reason from this union is everything an
 * error response says. Paths, environment values, stack traces, and raw
 * command output are never present.
 */
export type WarningReason = "CONFIG_UNPARSEABLE" | "SEGMENT_UNREADABLE";

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
