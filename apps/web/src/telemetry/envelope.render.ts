import type {
  ErrorEnvelope,
  StreamEnvelope,
  StreamErrorCode,
  StreamEventName,
} from "./envelope.interface";
import { parseStreamId, renderStreamId } from "./stream-id.render";

const EVENT_NAMES: readonly StreamEventName[] = [
  "score.snapshot.project",
  "score.telemetry.span",
  "score.telemetry.event",
  "score.telemetry.metric",
  "score.telemetry.log",
  "score.stream.caught_up",
  "score.stream.error",
];

/**
 * SSE wire rendering and parsing. A frame is `id:` (when a sequence rides),
 * `event:`, then one `data:` line per newline in the JSON payload — the SSE
 * spec joins them back with newlines, so multi-line JSON survives the trip.
 */
export function renderEnvelope(envelope: StreamEnvelope): string {
  // Excess keys ride along for open payload types, but the error contract
  // is closed: structural typing lets a caller spread extra fields into
  // error data (a stack trace, a path), so the wire projection for error
  // frames is explicit — only reason_code ever leaves the process.
  const data =
    envelope.event === "score.stream.error"
      ? { reason_code: envelope.data.reason_code }
      : envelope.data;
  const lines: string[] = [];
  if (envelope.sequence !== undefined) lines.push(`id: ${renderStreamId(envelope.sequence)}`);
  lines.push(`event: ${envelope.event}`);
  for (const line of JSON.stringify(data).split("\n")) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

/** Inverse of {@link renderEnvelope}; `undefined` on any non-frame input. */
export function parseEnvelope(block: string): StreamEnvelope | undefined {
  let sequence: StreamEnvelope["sequence"];
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("id: ")) {
      sequence = parseStreamId(line.slice(4));
      if (sequence === undefined) return undefined;
    } else if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data.push(line.slice(6));
    } else {
      return undefined;
    }
  }
  if (event === undefined || data.length === 0) return undefined;
  // A frame with an event name outside the closed v1 set is not ours —
  // reject rather than admit an unknown name as a parsed envelope.
  if (!EVENT_NAMES.includes(event as StreamEventName)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    return undefined;
  }
  if (!payloadMatches(event as StreamEventName, payload)) return undefined;
  // The guards above are the runtime proof of the discriminated union the
  // interface declares; the cast only re-joins what the two already agreed.
  return {
    event: event as StreamEventName,
    data: payload,
    ...(sequence && { sequence }),
  } as StreamEnvelope;
}

/**
 * Payload guards per event name: the parser's return type promises a
 * `StreamEventData`, so every recognized name must prove its payload's
 * shape — a well-named frame with a malformed body is not a frame. Checks
 * are structural only, matching the reader's tolerance: unknown fields ride
 * along untouched, exactly as TelemetryLogService parses stored lines.
 * `score.telemetry.metric`/`log` have no payload vocabulary in v1 (#53);
 * until one exists, no payload can prove itself theirs.
 */
function payloadMatches(event: StreamEventName, payload: unknown): boolean {
  switch (event) {
    case "score.snapshot.project":
      return (
        isRecord(payload) &&
        string(payload.project) &&
        string(payload.health) &&
        string(payload.observed_at)
      );
    case "score.telemetry.span":
      return (
        isRecord(payload) &&
        isTelemetryRecordPayload(event, payload) &&
        // TelemetrySpan.span_id is required — without it a consumer that
        // narrows on kind === "span" reads undefined for a declared string.
        string(payload.record.span_id) &&
        optionalField(payload.record.parent_span_id, string) &&
        optionalField(payload.record.duration_ms, isNumber) &&
        optionalField(payload.record.status, isSpanStatus)
      );
    case "score.telemetry.event":
      return isRecord(payload) && isTelemetryRecordPayload(event, payload);
    case "score.telemetry.metric":
    case "score.telemetry.log":
      return false;
    case "score.stream.caught_up":
      return isRecord(payload) && payload.follow === true && isCursorMap(payload.through);
    case "score.stream.error":
      return (
        isRecord(payload) &&
        (payload.reason_code === "cursor-expired" ||
          payload.reason_code === "not-ready" ||
          payload.reason_code === "internal")
      );
  }
}

/** Fields every record payload carries, whatever its kind. */
function isTelemetryRecordPayload(
  event: StreamEventName,
  payload: Record<string, unknown>,
): payload is { source: string; record: Record<string, unknown> } {
  const record = payload.record;
  return (
    (payload.source === "telemetry" || payload.source === "log") &&
    isRecord(record) &&
    record.kind === event.slice("score.telemetry.".length) &&
    typeof record.version === "number" &&
    string(record.time) &&
    string(record.name) &&
    isResource(record.resource) &&
    optionalField(record.subject, isSubject) &&
    optionalField(record.attributes, isAttributes)
  );
}

function isResource(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && string(value.project) && optionalField(value.daemon_pid, isNumber);
}

/**
 * Subject members copy dispatch identity verbatim; each proves its declared
 * type when present, so a consumer trusting TelemetrySubject never reads a
 * number where a session name was promised.
 */
function isSubject(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    optionalField(value.session, string) &&
    optionalField(value.branch, string) &&
    optionalField(value.issue_number, isNumber) &&
    optionalField(value.pull_request_number, isNumber)
  );
}

/** Attribute values are primitives only — the record contract's whole shape. */
function isAttributes(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (attribute) =>
        typeof attribute === "string" ||
        typeof attribute === "number" ||
        typeof attribute === "boolean",
    )
  );
}

/** Optional fields prove their type only when present; absent is valid. */
function optionalField<T>(value: unknown, check: (candidate: unknown) => candidate is T): boolean {
  return value === undefined || check(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isSpanStatus(value: unknown): value is "ok" | "error" {
  return value === "ok" || value === "error";
}

/** The fleet cursor is the resume token — every entry must be a real cursor. */
function isCursorMap(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (cursor) =>
      isRecord(cursor) &&
      string(cursor.project) &&
      (cursor.source === "telemetry" || cursor.source === "log") &&
      string(cursor.segment) &&
      typeof cursor.byte_offset === "number",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * The only error shape the stream ever admits: a reason code from a closed
 * set. Paths, messages, and stack traces stay server-side — an operator
 * debugging an error frame goes to the daemon's own logs, not the wire.
 */
export function streamErrorEnvelope(reasonCode: StreamErrorCode): ErrorEnvelope {
  return { event: "score.stream.error", data: { reason_code: reasonCode } };
}
