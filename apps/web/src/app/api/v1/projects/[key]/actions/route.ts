// Thin HTTP layer over the fleet actions: POST { action } runs the TUI's
// start/stop/restart with the TUI's guards. Semantics live in src/fleet/;
// error payloads are the v1 envelope's enum-only warning shape.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { PROJECT_KEY_PATTERN } from "@score/shared/config/load";
import { restartProject, startProject, stopProject } from "../../../../../../fleet/actions.service";
import { type FleetWarningReason, fleetEnvelope } from "../../../../../../fleet/envelope.render";
import { fleetDeps } from "../../../../../../fleet/fleet.service";

type Action = "start" | "stop" | "restart";

function refuse(reason: FleetWarningReason, status: number): Response {
  return Response.json(fleetEnvelope(null, [{ reason }]), { status });
}

/**
 * The console binds loopback, but the browser is a confused deputy: any
 * website a user visits can fire a cross-origin "simple" POST at 127.0.0.1
 * (text/plain needs no preflight, and the sender doesn't need to read the
 * response to do damage), so a drive-by page must not reach the lifecycle
 * verbs. Browsers always attach Origin to cross-origin POSTs — refuse any
 * that names a foreign host, and refuse opaque ("null") origins outright.
 * Non-browser clients (curl, scripts) send no Origin and stay welcome.
 */
function foreignOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

async function parseAction(request: Request): Promise<Action | null> {
  try {
    const body = (await request.json()) as { action?: unknown };
    const action = body?.action;
    if (action === "start" || action === "stop" || action === "restart") return action;
  } catch {
    // Non-JSON body — same refusal as an unknown action.
  }
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;
  if (foreignOrigin(request)) return refuse("ORIGIN_FORBIDDEN", 403);
  // Pattern-checked before any filesystem or supervisor touch: the key names
  // paths (job.plist, state dir) and a launchd label.
  if (!PROJECT_KEY_PATTERN.test(key)) return refuse("PROJECT_KEY_INVALID", 400);
  const action = await parseAction(request);
  if (action === null) return refuse("ACTION_INVALID", 400);

  const deps = fleetDeps();
  const config = await deps.readConfig();
  if (config === null) return refuse("CONFIG_UNPARSEABLE", 503);
  let job: { readonly loaded: boolean } | undefined;
  try {
    job = (await deps.adapter.status()).find((candidate) => candidate.key === key);
  } catch {
    return refuse("SUPERVISOR_UNREADABLE", 503);
  }
  // Known = the same union the TUI acted on: config projects plus any
  // score-namespace job the supervisor still knows about.
  if (config.projects[key] === undefined && job === undefined) {
    return refuse("PROJECT_UNKNOWN", 404);
  }
  // The TUI's guard: stopping a running disabled job is fine, starting one
  // (or restarting, which ends in a start) is not.
  const enabled = config.projects[key]?.enabled ?? false;
  if (!enabled && action !== "stop") return refuse("PROJECT_DISABLED", 400);

  try {
    if (action === "start") {
      // A crashed job is still registered with the supervisor: start alone.
      // A booted-out or definition-only job needs install-then-start.
      await startProject(deps.adapter, key, job?.loaded === true);
    } else if (action === "stop") {
      await stopProject(deps.adapter, key);
    } else {
      await restartProject(deps.adapter, key);
    }
  } catch {
    // Missing saved definition or a supervisor refusal: the remedy
    // (`score up <key>`) is CLI guidance, never API payload.
    return refuse("ACTION_FAILED", 500);
  }
  return Response.json(fleetEnvelope({ key, action }, []));
}

// Lifecycle verbs travel only through POST; everything else is refused here,
// not left to framework defaults.
function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
