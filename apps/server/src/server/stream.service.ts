/**
 * Express response adaptation for an already-open telemetry stream. Query
 * policy and frame rendering stay with telemetry; this service owns socket
 * backpressure, disconnect cleanup, and live-stream shutdown only.
 */

import type { Request, Response } from "express";
import type { StreamOutcome } from "../telemetry/stream/stream.service";

type OpenStreamOutcome = Extract<StreamOutcome, { readonly kind: "stream" }>;

export class StreamResponseService {
  private readonly live = new Set<() => void>();
  private closing = false;

  async send(req: Request, res: Response, outcome: OpenStreamOutcome): Promise<void> {
    const frames = outcome.frames();
    let closing = false;
    let finalizing: Promise<void> | undefined;

    const finalize = (): Promise<void> => {
      if (finalizing !== undefined) return finalizing;
      closing = true;
      finalizing = (async () => {
        try {
          outcome.close();
        } finally {
          await frames.return(undefined);
        }
      })();
      return finalizing;
    };

    const close = (): void => {
      void finalize();
      // Ending the HTTP response independently of generator cleanup keeps
      // process shutdown bounded even if an injected source misbehaves.
      if (!res.destroyed && !res.writableEnded) res.end();
    };
    const untrack = (): void => {
      this.live.delete(close);
    };
    const disconnected = (): void => {
      close();
    };

    // openStream() may have started before shutdown and resolve afterward.
    // Refuse that late handoff so http.close() cannot inherit an untracked
    // follow stream after the shutdown sweep has already run.
    if (this.closing) {
      await finalize();
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }

    this.live.add(close);
    req.once("aborted", disconnected);
    res.once("close", disconnected);
    res.once("error", disconnected);

    try {
      if (req.aborted || res.destroyed) return;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-store");
      res.flushHeaders();
      for (;;) {
        const next = await frames.next();
        if (closing) return;
        if (next.done) {
          res.end();
          return;
        }
        if (!res.write(next.value) && !(await waitForDrain(res))) return;
      }
    } finally {
      await finalize();
      req.off("aborted", disconnected);
      res.off("close", disconnected);
      res.off("error", disconnected);
      untrack();
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  closeAll(): void {
    this.closing = true;
    for (const close of [...this.live]) close();
  }
}

/** A full kernel buffer must never let a dead client park the pump forever. */
function waitForDrain(res: Response): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (writable: boolean): void => {
      res.off("drain", drained);
      res.off("close", closed);
      res.off("error", closed);
      resolve(writable);
    };
    const drained = (): void => done(true);
    const closed = (): void => done(false);
    res.once("drain", drained);
    res.once("close", closed);
    res.once("error", closed);
  });
}
