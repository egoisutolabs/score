import type { StreamSequence } from "./envelope.interface";

/**
 * Stream IDs are opaque on the wire: base64 JSON of the sequence map, so a
 * client echoes `Last-Event-ID` back without ever interpreting the scheme
 * (same contract as FleetCursor — the reader owns the key scheme).
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function renderStreamId(sequence: StreamSequence): string {
  return Buffer.from(JSON.stringify(sequence), "utf8").toString("base64");
}

/**
 * Anything the wire never carried parses to `undefined` — a bogus
 * `Last-Event-ID` must downgrade the client to a fresh sequence, never
 * surface as a partially-trusted counter map.
 */
export function parseStreamId(id: string): StreamSequence | undefined {
  if (id === "" || !BASE64.test(id)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(id, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const sequence: Record<string, number> = {};
  for (const [scope, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
    sequence[scope] = value;
  }
  return sequence;
}
