/** Shared boot logic for opencode-server.service.test.ts's stub executables. */
export function startStubServer(
  fetchHandler: (request: Request) => Response | Promise<Response>,
): void {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetchHandler });
  console.log(`opencode server listening on http://127.0.0.1:${server.port}`);
}

export function docHandler(request: Request): Response {
  return new URL(request.url).pathname === "/doc"
    ? new Response("{}", { headers: { "content-type": "application/json" } })
    : new Response("not found", { status: 404 });
}
