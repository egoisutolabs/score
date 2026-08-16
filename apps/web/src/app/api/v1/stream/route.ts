// Minimal SSE handshake: exactly one score.stream.hello envelope, clean
// close. Replay, cursors, filters, snapshots, follow are #81/#82 scope.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { HELLO_EVENT } from "../../../../telemetry/stream-envelope.interface";
import { envelope, sseFrame } from "../../../../telemetry/stream-envelope.render";

export function GET(): Response {
  // A fixed-length body is the clean close: the connection ends after the
  // one frame. The stream stays open only once #82 adds follow.
  return new Response(sseFrame(HELLO_EVENT, envelope({})), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}
