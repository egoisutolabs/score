import type {
  StreamEnvelope,
  StreamErrorData,
  StreamEventData,
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
  const lines: string[] = [];
  if (envelope.sequence !== undefined) lines.push(`id: ${renderStreamId(envelope.sequence)}`);
  lines.push(`event: ${envelope.event}`);
  for (const line of JSON.stringify(envelope.data).split("\n")) {
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
  return {
    event: event as StreamEventName,
    data: payload as StreamEventData,
    ...(sequence && { sequence }),
  };
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
    case "score.telemetry.event":
      return (
        isRecord(payload) &&
        (payload.source === "telemetry" || payload.source === "log") &&
        isRecord(payload.record) &&
        payload.record.kind === event.slice("score.telemetry.".length) &&
        typeof payload.record.version === "number" &&
        string(payload.record.time) &&
        string(payload.record.name) &&
        isRecord(payload.record.resource) &&
        string(payload.record.resource.project)
      );
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
export function streamErrorEnvelope(
  reasonCode: StreamErrorData["reason_code"],
): StreamEnvelope<StreamErrorData> {
  return { event: "score.stream.error", data: { reason_code: reasonCode } };
}
