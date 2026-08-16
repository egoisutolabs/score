// Thin HTTP layer over the fleet feature: one poll cycle's ProjectViews as
// JSON. Semantics live in src/fleet/; error payloads render as the v1
// envelope's enum-only warning shape — no paths, no supervisor output.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { fleetEnvelope } from "../../../../fleet/envelope.render";
import { fleetDeps } from "../../../../fleet/fleet.service";
import { projectViewJson } from "../../../../fleet/project-view.render";
import { fleetSnapshot } from "../../../../fleet/snapshot.service";

export async function GET(): Promise<Response> {
  const deps = fleetDeps();
  const config = await deps.readConfig();
  if (config === null) {
    return Response.json(fleetEnvelope(null, [{ reason: "CONFIG_UNPARSEABLE" }]), { status: 503 });
  }
  try {
    const views = await fleetSnapshot(deps.adapter, config, deps.now().getTime());
    return Response.json(fleetEnvelope({ projects: views.map(projectViewJson) }, []));
  } catch {
    // launchctl/systemctl failed: the reason enum is the whole story.
    return Response.json(fleetEnvelope(null, [{ reason: "SUPERVISOR_UNREADABLE" }]), {
      status: 503,
    });
  }
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
