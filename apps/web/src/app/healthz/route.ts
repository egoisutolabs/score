// Liveness only: the process responds. Zero file reads, zero dependencies —
// /healthz cannot fail while the process serves. Readiness is #80's scope.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", { status: 200 });
}
