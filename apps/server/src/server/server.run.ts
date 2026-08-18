/**
 * Listening lifecycle for the Express adapter. Route construction remains
 * independently testable and importing the package never opens a socket.
 */

import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, type ScoreServer } from "./server.service";

const stopping = new WeakMap<HttpServer, Promise<void>>();

export interface ServerListenOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface RunningServer {
  readonly definition: ScoreServer;
  readonly http: HttpServer;
  readonly host: string;
  readonly port: number;
}

export async function startServer(
  definition: ScoreServer = createServer(),
  options: ServerListenOptions = {},
): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const http = await new Promise<HttpServer>((resolve, reject) => {
    const listening = definition.app.listen(port, host);
    const failed = (error: Error): void => reject(error);
    listening.once("error", failed);
    listening.once("listening", () => {
      // Startup failures belong to this promise; later server errors must not
      // be swallowed by a stale rejection listener after it has settled.
      listening.off("error", failed);
      resolve(listening);
    });
  });
  const address = http.address() as AddressInfo;
  return { definition, http, host: address.address, port: address.port };
}

export async function stopServer(running: RunningServer): Promise<void> {
  const existing = stopping.get(running.http);
  if (existing !== undefined) return existing;
  const closed = new Promise<void>((resolve, reject) => {
    running.http.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  stopping.set(running.http, closed);
  running.definition.closeStreams();
  // Bun's Node-compatible server can retain already-idle keep-alive sockets
  // after close(); they carry no work and must not delay process shutdown.
  running.http.closeIdleConnections();
  await closed;
}
