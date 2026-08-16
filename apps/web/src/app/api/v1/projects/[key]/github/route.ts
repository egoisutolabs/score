// Thin HTTP layer over the fleet's live GitHub observation: open PRs with
// the landing phase's own verdicts (mergeable, checks, reviews) plus the
// open-issue count. Read-only by construction — the service only composes
// the daemon adapter's observe* methods. Error payloads are the v1
// envelope's enum-only warning shape.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { PROJECT_KEY_PATTERN } from "@score/shared/config/load";
import { type FleetWarningReason, fleetEnvelope } from "../../../../../../fleet/envelope.render";
import { GithubUnconfiguredError, observeGithub } from "../../../../../../fleet/github.service";

function refuse(reason: FleetWarningReason, status: number): Response {
  return Response.json(fleetEnvelope(null, [{ reason }]), { status });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;
  // Pattern-checked before any filesystem touch: the key names state paths.
  if (!PROJECT_KEY_PATTERN.test(key)) return refuse("PROJECT_KEY_INVALID", 400);
  try {
    return Response.json(fleetEnvelope(await observeGithub(key), []));
  } catch (error) {
    // Enum-only either way; the remedy for an unconfigured project is CLI
    // guidance the console owns, and gh failures never leak output.
    if (error instanceof GithubUnconfiguredError) return refuse("GITHUB_UNCONFIGURED", 409);
    return refuse("GITHUB_UNREADABLE", 503);
  }
}

// The read-only surface: every mutating verb is refused here, not left to
// framework defaults.
function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { allow: "GET" } });
}
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
