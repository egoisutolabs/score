import { expect, test } from "vitest";
import type { StreamOutcome } from "../telemetry/stream/stream.service";
import { type RunningServer, startServer, stopServer } from "./server.run";
import { createServer, type ScoreServer, type ServerDependencies } from "./server.service";

interface TestServer {
  readonly running: RunningServer;
  readonly url: string;
}

function dependencies(overrides: Partial<ServerDependencies> = {}): ServerDependencies {
  return {
    checkReadiness: () => ({ ready: true }),
    observeHistory: async () => ({ kind: "ok", merges: [], warnings: [] }),
    openStream: async () => ({
      kind: "error",
      status: 400,
      reason: "FILTER_INVALID",
    }),
    ...overrides,
  };
}

async function listen(definition: ScoreServer): Promise<TestServer> {
  const running = await startServer(definition, { port: 0 });
  return { running, url: `http://127.0.0.1:${running.port}` };
}

test("real HTTP serves liveness without touching readiness or stream dependencies", async () => {
  const fail = (): never => {
    throw new Error("dependency must remain unreachable");
  };
  const server = await listen(
    createServer({ checkReadiness: fail, observeHistory: fail, openStream: fail }),
  );
  try {
    const response = await fetch(`${server.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  } finally {
    await stopServer(server.running);
  }
});

test("real HTTP shapes ready and not-ready probes", async () => {
  let ready = true;
  const server = await listen(
    createServer(
      dependencies({
        checkReadiness: () =>
          ready ? { ready: true } : { ready: false, reason: "CONFIG_UNPARSEABLE" },
      }),
    ),
  );
  try {
    const healthy = await fetch(`${server.url}/readyz`);
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toBe("ok");

    ready = false;
    const unavailable = await fetch(`${server.url}/readyz`);
    expect(unavailable.status).toBe(503);
    const text = await unavailable.text();
    const body = JSON.parse(text);
    expect(body.data).toBeNull();
    expect(body.warnings).toEqual([{ reason: "CONFIG_UNPARSEABLE" }]);
    expect(text).not.toContain("Error");
  } finally {
    await stopServer(server.running);
  }
});

test("real HTTP preserves the finite SSE transcript, original query, and cursor header", async () => {
  const transcript =
    'id: cursor-1\nevent: score.stream.hello\ndata: {"api_version":"v1"}\n\n' +
    'id: cursor-2\nevent: score.stream.caught_up\ndata: {"api_version":"v1"}\n\n';
  let seenParams: readonly [string, string][] = [];
  let seenCursor: string | null = null;
  let closes = 0;
  let finalized = 0;
  const outcome: Extract<StreamOutcome, { readonly kind: "stream" }> = {
    kind: "stream",
    frames: async function* () {
      try {
        yield transcript.slice(0, transcript.indexOf("id: cursor-2"));
        yield transcript.slice(transcript.indexOf("id: cursor-2"));
      } finally {
        finalized += 1;
      }
    },
    close: () => {
      closes += 1;
    },
  };
  const server = await listen(
    createServer(
      dependencies({
        openStream: async (params, lastEventId) => {
          seenParams = [...params.entries()];
          seenCursor = lastEventId;
          return outcome;
        },
      }),
    ),
  );
  try {
    const response = await fetch(`${server.url}/api/v1/stream?projects=alpha%2Cbeta&follow=false`, {
      headers: { "Last-Event-ID": "resume-here" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(transcript);
    expect(seenParams).toEqual([
      ["projects", "alpha,beta"],
      ["follow", "false"],
    ]);
    expect(seenCursor).toBe("resume-here");
    expect(closes).toBe(1);
    expect(finalized).toBe(1);
  } finally {
    await stopServer(server.running);
  }
});

test("stream errors remain enum-only v1 envelopes over real HTTP", async () => {
  const server = await listen(
    createServer(
      dependencies({
        openStream: async () => ({
          kind: "error",
          status: 410,
          reason: "CURSOR_EXPIRED",
        }),
      }),
    ),
  );
  try {
    const response = await fetch(`${server.url}/api/v1/stream`);
    expect(response.status).toBe(410);
    const body = JSON.parse(await response.text());
    expect(body.data).toBeNull();
    expect(body.warnings).toEqual([{ reason: "CURSOR_EXPIRED" }]);
    expect(Object.keys(body.warnings[0])).toEqual(["reason"]);
  } finally {
    await stopServer(server.running);
  }
});

test("stream mutators and HEAD are explicitly 405 with Allow GET", async () => {
  let opened = 0;
  const server = await listen(
    createServer(
      dependencies({
        openStream: async () => {
          opened += 1;
          return { kind: "error", status: 400, reason: "FILTER_INVALID" };
        },
      }),
    ),
  );
  try {
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${server.url}/api/v1/stream`, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("GET");
      expect(await response.text(), method).toBe("");
    }
    expect(opened).toBe(0);
  } finally {
    await stopServer(server.running);
  }
});

test("history returns GitHub merges through a bounded read-only route", async () => {
  let since = 0;
  const server = await listen(
    createServer(
      dependencies({
        observeHistory: async (sinceMs) => {
          since = sinceMs;
          return {
            kind: "ok",
            merges: [
              {
                project: "score",
                pull_request_number: 103,
                title: "Port API to Express",
                merged_at: "2026-08-18T01:25:50Z",
              },
            ],
            warnings: [],
          };
        },
      }),
    ),
  );
  try {
    const response = await fetch(`${server.url}/api/v1/history?since=2026-08-18T00%3A00%3A00.000Z`);
    expect(response.status).toBe(200);
    expect(since).toBe(Date.parse("2026-08-18T00:00:00.000Z"));
    const body = (await response.json()) as { readonly data: unknown };
    expect(body.data).toEqual([
      {
        project: "score",
        pull_request_number: 103,
        title: "Port API to Express",
        merged_at: "2026-08-18T01:25:50Z",
      },
    ]);

    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      const denied = await fetch(`${server.url}/api/v1/history`, { method });
      expect(denied.status, method).toBe(405);
      expect(denied.headers.get("allow"), method).toBe("GET");
    }
  } finally {
    await stopServer(server.running);
  }
});

test("history rejects unknown and malformed query parameters before GitHub", async () => {
  let observations = 0;
  const server = await listen(
    createServer(
      dependencies({
        observeHistory: async () => {
          observations += 1;
          return { kind: "ok", merges: [], warnings: [] };
        },
      }),
    ),
  );
  try {
    const unknown = await fetch(`${server.url}/api/v1/history?range=30d`);
    expect(unknown.status).toBe(400);
    const unknownBody = (await unknown.json()) as { readonly warnings: unknown };
    expect(unknownBody.warnings).toEqual([{ reason: "FILTER_UNKNOWN" }]);
    const malformed = await fetch(`${server.url}/api/v1/history?since=yesterday`);
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as { readonly warnings: unknown };
    expect(malformedBody.warnings).toEqual([{ reason: "FILTER_INVALID" }]);
    expect(observations).toBe(0);
  } finally {
    await stopServer(server.running);
  }
});

test("shutdown closes a live subscription before waiting for the HTTP server", async () => {
  let release: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closes = 0;
  let finalized = 0;
  const server = await listen(
    createServer(
      dependencies({
        openStream: async () => ({
          kind: "stream",
          frames: async function* () {
            try {
              yield "event: score.stream.hello\ndata: {}\n\n";
              await parked;
            } finally {
              finalized += 1;
            }
          },
          close: () => {
            closes += 1;
            release?.();
          },
        }),
      }),
    ),
  );

  const response = await fetch(`${server.url}/api/v1/stream`);
  const reader = response.body?.getReader();
  expect((await reader?.read())?.done).toBe(false);
  await stopServer(server.running);
  await stopServer(server.running);
  expect(closes).toBe(1);
  await reader?.cancel();
  await Promise.resolve();
  expect(finalized).toBe(1);
});

test("shutdown closes a stream whose open finishes after the shutdown sweep", async () => {
  let finishOpen: ((outcome: StreamOutcome) => void) | undefined;
  let opening = false;
  let closes = 0;
  const server = await listen(
    createServer(
      dependencies({
        openStream: () => {
          opening = true;
          return new Promise<StreamOutcome>((resolve) => {
            finishOpen = resolve;
          });
        },
      }),
    ),
  );

  const request = fetch(`${server.url}/api/v1/stream`);
  while (!opening) await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = stopServer(server.running);
  finishOpen?.({
    kind: "stream",
    frames: async function* () {
      yield "event: score.stream.hello\ndata: {}\n\n";
    },
    close: () => {
      closes += 1;
    },
  });

  await stopping;
  expect((await request).status).toBe(200);
  expect(closes).toBe(1);
});
