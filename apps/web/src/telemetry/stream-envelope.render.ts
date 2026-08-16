import { randomUUID } from "node:crypto";
import type { ApiWarning, StreamEnvelope } from "./stream-envelope.interface";

/**
 * Wrap a payload in a fresh v1 envelope. `warnings` is spread conditionally
 * so an envelope without warnings JSON round-trips byte-identical — no
 * `undefined` field to drop. Cursor encoding is #81 scope; a handshake or
 * probe response has no durable position yet, so the cursor is empty.
 */
export function envelope<T>(data: T, warnings?: readonly ApiWarning[]): StreamEnvelope<T> {
  return {
    api_version: "v1",
    emitted_at: new Date().toISOString(),
    stream_id: randomUUID(),
    cursor: "",
    data,
    ...(warnings !== undefined && { warnings }),
  };
}

/**
 * One SSE frame: optional `id:` (the composite cursor a client echoes back
 * as Last-Event-ID), named event, the envelope as `data:`, blank-line
 * terminator.
 */
export function sseFrame(event: string, body: StreamEnvelope<unknown>, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}
