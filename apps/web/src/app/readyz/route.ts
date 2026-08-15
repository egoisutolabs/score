import { NextResponse } from "next/server";
import { assessReadiness } from "../../telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Readiness: alive (healthz) is not readable (here) — an unreadable config or
// telemetry store flips this probe to 503 with the failing check's reason code.
export async function GET() {
  const report = await assessReadiness();
  return NextResponse.json(report, { status: report.ready ? 200 : 503 });
}
