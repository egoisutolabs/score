// Thin HTTP layer over the stream feature (#81): parse the URL and
// Last-Event-ID, refuse mutating verbs, and pump the subscribe's frame
// generator through an SSE body. Semantics live in src/telemetry/stream/;
// error payloads render as the v1 envelope's enum-only warning shape.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { openStream } from "../../../../telemetry/stream/stream.service";
import { envelope } from "../../../../telemetry/stream-envelope.render";

export async function GET(request: Request): Promise<Response> {
  const outcome = await openStream(
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
  // A closing stream is the clean close: the body ends after the last frame
  // (caught_up, or the follow seam's warning). #82 keeps it open.
  return new Response(
    new ReadableStream({
      pull(controller) {
        const next = frames.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
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
