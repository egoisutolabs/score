/**
 * Express route composition for Score's read-only telemetry API. Domain
 * decisions remain in telemetry services; this module owns HTTP semantics.
 */

import { isRfc3339 } from "@score/core/telemetry/telemetry.policy";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { type HistoryOutcome, HistoryService } from "../history";
import { type ReadinessResult, ReadinessService } from "../telemetry/readiness.service";
import { type StreamOutcome, StreamService } from "../telemetry/stream/stream.service";
import { envelope } from "../telemetry/stream-envelope.render";
import { StreamResponseService } from "./stream.service";

export interface ServerDependencies {
  readonly checkReadiness: () => ReadinessResult;
  readonly observeHistory: (sinceMs: number) => Promise<HistoryOutcome>;
  readonly openStream: (
    params: URLSearchParams,
    lastEventId: string | null,
  ) => Promise<StreamOutcome>;
}

export interface ScoreServer {
  readonly app: Express;
  readonly closeStreams: () => void;
}

export function defaultServerDependencies(): ServerDependencies {
  const history = new HistoryService();
  return {
    checkReadiness: () => new ReadinessService().check(),
    observeHistory: (sinceMs) => history.observe(sinceMs),
    openStream: (params, lastEventId) => new StreamService().open(params, lastEventId),
  };
}

export function createServer(deps: ServerDependencies = defaultServerDependencies()): ScoreServer {
  const app = express();
  const streams = new StreamResponseService();

  app.get("/healthz", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  app.get("/readyz", (_req, res) => {
    const result = deps.checkReadiness();
    if (result.ready) {
      res.status(200).type("text/plain").send("ok");
      return;
    }
    res.status(503).json(envelope(null, [{ reason: result.reason }]));
  });

  app.head("/api/v1/history", methodNotAllowed);
  app.get(
    "/api/v1/history",
    asyncHandler(async (req, res) => {
      const parsed = historySince(searchParams(req.originalUrl));
      if (parsed.kind === "error") {
        res.status(400).json(envelope(null, [{ reason: parsed.reason }]));
        return;
      }
      const outcome = await deps.observeHistory(parsed.sinceMs);
      if (outcome.kind === "error") {
        res.status(outcome.status).json(envelope(null, [{ reason: outcome.reason }]));
        return;
      }
      res
        .status(200)
        .json(
          envelope(outcome.merges, outcome.warnings.length === 0 ? undefined : outcome.warnings),
        );
    }),
  );
  app.post("/api/v1/history", methodNotAllowed);
  app.put("/api/v1/history", methodNotAllowed);
  app.patch("/api/v1/history", methodNotAllowed);
  app.delete("/api/v1/history", methodNotAllowed);

  // Express treats HEAD as GET unless it is registered first. A probe must
  // not allocate a generator that can wait forever for a body nobody reads.
  app.head("/api/v1/stream", methodNotAllowed);
  app.get(
    "/api/v1/stream",
    asyncHandler(async (req, res) => {
      const outcome = await deps.openStream(
        searchParams(req.originalUrl),
        req.get("Last-Event-ID") ?? null,
      );
      if (outcome.kind === "error") {
        res.status(outcome.status).json(envelope(null, [{ reason: outcome.reason }]));
        return;
      }
      await streams.send(req, res, outcome);
    }),
  );
  app.post("/api/v1/stream", methodNotAllowed);
  app.put("/api/v1/stream", methodNotAllowed);
  app.patch("/api/v1/stream", methodNotAllowed);
  app.delete("/api/v1/stream", methodNotAllowed);

  // Unexpected faults are outside the v1 reason vocabulary. Close them
  // without inventing a warning reason or exposing Express's stack page.
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      if (!res.destroyed) res.end();
      return;
    }
    res.status(500).end();
  });

  return { app, closeStreams: () => streams.closeAll() };
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.setHeader("Allow", "GET");
  res.status(405).end();
}

function searchParams(originalUrl: string): URLSearchParams {
  const query = originalUrl.indexOf("?");
  return new URLSearchParams(query === -1 ? "" : originalUrl.slice(query + 1));
}

function historySince(
  params: URLSearchParams,
):
  | { readonly kind: "ok"; readonly sinceMs: number }
  | { readonly kind: "error"; readonly reason: "FILTER_UNKNOWN" | "FILTER_INVALID" } {
  if ([...params.keys()].some((key) => key !== "since")) {
    return { kind: "error", reason: "FILTER_UNKNOWN" };
  }
  const values = params.getAll("since");
  if (values.length !== 1) return { kind: "error", reason: "FILTER_INVALID" };
  const value = values[0] ?? "";
  if (!isRfc3339(value)) return { kind: "error", reason: "FILTER_INVALID" };
  const sinceMs = Date.parse(value);
  if (Number.isNaN(sinceMs)) return { kind: "error", reason: "FILTER_INVALID" };
  return { kind: "ok", sinceMs };
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}
