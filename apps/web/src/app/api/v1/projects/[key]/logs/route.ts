// Thin HTTP layer over the fleet log tail: GET ?cursor= polls one window of
// the project's dated log. Semantics live in src/fleet/tail.service.ts; an
// invalid or stale cursor degrades to a fresh tail, never an error.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { logsDir } from "@score/shared/config/layout";
import { PROJECT_KEY_PATTERN } from "@score/shared/config/load";
import { fleetEnvelope } from "../../../../../../fleet/envelope.render";
import { fleetDeps } from "../../../../../../fleet/fleet.service";
import { tailPoll } from "../../../../../../fleet/tail.service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;
  // Pattern-checked before any filesystem touch: the key names a path.
  if (!PROJECT_KEY_PATTERN.test(key)) {
    return Response.json(fleetEnvelope(null, [{ reason: "PROJECT_KEY_INVALID" }]), { status: 400 });
  }
  const cursor = new URL(request.url).searchParams.get("cursor");
  const window = await tailPoll(logsDir(key), cursor, fleetDeps().now);
  return Response.json(fleetEnvelope(window, []));
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
