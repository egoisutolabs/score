// Readiness: the stores the telemetry API reads are readable. Thin parser
// only — the matrix lives in ReadinessService. Errors render as the v1
// envelope's warning shape: a reason enum, never paths, environment values,
// stack traces, or command output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { ReadinessService } from "../../telemetry/readiness.service";
import { envelope } from "../../telemetry/stream-envelope.render";

export function GET(): Response {
  const result = new ReadinessService().check();
  if (result.ready) return new Response("ok", { status: 200 });
  return Response.json(envelope(null, [{ reason: result.reason }]), { status: 503 });
}
