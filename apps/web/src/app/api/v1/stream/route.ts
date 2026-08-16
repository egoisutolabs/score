// Thin HTTP layer over the stream feature (#81): parse the URL and
// Last-Event-ID, refuse mutating verbs, and pump the subscribe's frame
// generator through an SSE body. Semantics live in src/telemetry/stream/;
// error payloads render as the v1 envelope's enum-only warning shape.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { StreamService } from "../../../../telemetry/stream/stream.service";
import { envelope } from "../../../../telemetry/stream-envelope.render";

export async function GET(request: Request): Promise<Response> {
  const outcome = await new StreamService().open(
    new URL(request.url).searchParams,
    request.headers.get("last-event-id"),
  );
  if (outcome.kind === "error") {
    return Response.json(envelope(null, [{ reason: outcome.reason }]), {
      status: outcome.status,
    });
  }
  const frames = outcome.frames();
  const encoder = new TextEncoder();
  let cancelled = false;
  // The generator ends only on a clean close (follow=false's caught_up, a
  // mid-stream deletion warning, or a slow-consumer disconnect); follow
  // streams otherwise stay open, heartbeats included (#82).
  return new Response(
    new ReadableStream({
      async pull(controller) {
        const next = await frames.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      async cancel() {
        // Client went away: run the generator's cleanup so its shared
        // tailer refs release. A pending idle wait settles within one
        // heartbeat interval.
        cancelled = true;
        await frames.return(undefined);
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    },
  );
}

// The read-only surface, provable without a server: every mutating verb is
// refused here, not left to framework defaults.
function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { allow: "GET" } });
}
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
