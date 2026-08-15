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
  try {
    return {
      event: event as StreamEventName,
      data: JSON.parse(data.join("\n")) as StreamEventData,
      ...(sequence && { sequence }),
    };
  } catch {
    return undefined;
  }
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
