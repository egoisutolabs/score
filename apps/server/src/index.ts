/**
 * The server package exposes Score's read-only HTTP runtime; it does not own
 * telemetry semantics or daemon lifecycle policy.
 */

export * from "./server";
export * from "./telemetry";

import { createServer, startServer, stopServer } from "./server";

if (import.meta.main) {
  const configuredPort = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const running = await startServer(createServer(), {
    host: "127.0.0.1",
    port: configuredPort,
  });
  console.log(`Score server listening on http://${running.host}:${running.port}`);

  const shutdown = (): void => {
    void stopServer(running).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
