import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness only, by construction: no file reads, so a corrupt or unreadable
// store can never take down the probe that says the process is alive.
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
