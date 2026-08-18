import { expect, test } from "vitest";
import { TuiServerClient } from "./server-client.service";

const NOW = new Date("2026-08-17T12:00:00.000Z");

function frame(event: string, data: unknown, cursor: string, warnings?: readonly string[]): string {
  return `id: ${cursor}\nevent: ${event}\ndata: ${JSON.stringify({
    api_version: "v1",
    emitted_at: NOW.toISOString(),
    stream_id: "stream-1",
    cursor,
    data,
    ...(warnings && { warnings: warnings.map((reason) => ({ reason })) }),
  })}\n\n`;
}

function project(
  key: string,
  health: "healthy" | "stale" | "crashed" | "stopped" = "healthy",
): unknown {
  return {
    project: key,
    enabled: true,
    supervisor: { loaded: true, pid: 123 },
    status: { tick: 7 },
    config: {
      harness: "claude",
      model: "sonnet",
      tick_interval_ms: 60_000,
      max_parallel: 2,
    },
    health: { state: health, reasons: ["OK"] },
    telemetry_watermark: [],
  };
}

function transcript(cursor: string, lines: readonly string[] = []): string {
  return (
    frame("score.stream.hello", {}, "") +
    frame("score.snapshot.project", project("alpha"), "") +
    lines
      .map((body) =>
        frame(
          "score.log.record",
          {
            project: "alpha",
            ts: "2026-08-17T11:59:00.000Z",
            level: "info",
            body,
          },
          cursor,
        ),
      )
      .join("") +
    frame("score.stream.caught_up", {}, cursor)
  );
}

function fakeFetch(responses: Response[]): {
  readonly request: typeof fetch;
  readonly calls: { readonly url: URL; readonly headers: Headers }[];
} {
  const calls: { url: URL; headers: Headers }[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: new URL(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
    });
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  };
  return { request: request as typeof fetch, calls };
}

test("poll maps server snapshots and logs, then resumes from caught_up", async () => {
  const http = fakeFetch([
    new Response(transcript("cursor-1", ["tick started"]), { status: 200 }),
    new Response(transcript("cursor-2", ["tick complete"]), { status: 200 }),
  ]);
  const client = new TuiServerClient("http://127.0.0.1:3000", http.request, () => NOW);

  const first = await client.poll();
  expect(first.projects).toEqual([
    {
      key: "alpha",
      enabled: true,
      job: { key: "alpha", loaded: true, pid: 123 },
      status: { tick: 7 },
      resolved: {
        agent: "claude · sonnet",
        tickIntervalMs: 60_000,
        maxParallel: 2,
      },
      dot: "green",
    },
  ]);
  expect(first.logs.get("alpha")).toEqual(["[2026-08-17T11:59:00.000Z] [info] tick started"]);
  expect(http.calls[0]?.url.searchParams.get("signals")).toBe("snapshot,log");
  expect(http.calls[0]?.url.searchParams.get("follow")).toBe("false");
  expect(http.calls[0]?.url.searchParams.get("since")).toBe("2026-08-17T00:00:00.000Z");
  expect(http.calls[0]?.headers.get("last-event-id")).toBeNull();

  const second = await client.poll();
  expect(http.calls[1]?.headers.get("last-event-id")).toBe("cursor-1");
  expect(second.logs.get("alpha")).toEqual([
    "[2026-08-17T11:59:00.000Z] [info] tick started",
    "[2026-08-17T11:59:00.000Z] [info] tick complete",
  ]);
});

test("snapshot warnings stay explicit while usable data still renders", async () => {
  const body =
    frame("score.snapshot.project", project("alpha", "stale"), "", ["SUPERVISOR_UNREADABLE"]) +
    frame("score.stream.caught_up", {}, "cursor-1");
  const http = fakeFetch([new Response(body, { status: 200 })]);
  const state = await new TuiServerClient("http://score.test", http.request, () => NOW).poll();

  expect(state.projects[0]?.dot).toBe("amber");
  expect(state.warnings).toEqual(["SUPERVISOR_UNREADABLE"]);
});

test("an expired cursor clears buffered logs and retries without Last-Event-ID", async () => {
  const expired = JSON.stringify({
    api_version: "v1",
    cursor: "",
    data: null,
    warnings: [{ reason: "CURSOR_EXPIRED" }],
  });
  const http = fakeFetch([
    new Response(transcript("cursor-1", ["old"]), { status: 200 }),
    new Response(expired, { status: 410 }),
    new Response(transcript("cursor-2", ["fresh"]), { status: 200 }),
  ]);
  const client = new TuiServerClient("http://score.test", http.request, () => NOW);
  await client.poll();
  const recovered = await client.poll();

  expect(http.calls[1]?.headers.get("last-event-id")).toBe("cursor-1");
  expect(http.calls[2]?.headers.get("last-event-id")).toBeNull();
  expect(recovered.logs.get("alpha")).toEqual(["[2026-08-17T11:59:00.000Z] [info] fresh"]);
});

test("a response without caught_up is rejected without advancing the cursor", async () => {
  const http = fakeFetch([
    new Response(
      frame("score.snapshot.project", project("alpha"), "cursor-bad") +
        frame(
          "score.log.record",
          {
            project: "alpha",
            ts: "2026-08-17T11:59:00.000Z",
            level: "info",
            body: "uncommitted",
          },
          "cursor-bad",
        ),
      { status: 200 },
    ),
    new Response(transcript("cursor-good", ["committed"]), { status: 200 }),
  ]);
  const client = new TuiServerClient("http://score.test", http.request, () => NOW);

  await expect(client.poll()).rejects.toThrow("server stream ended before score.stream.caught_up");
  const recovered = await client.poll();
  expect(http.calls[1]?.headers.get("last-event-id")).toBeNull();
  expect(recovered.logs.get("alpha")).toEqual(["[2026-08-17T11:59:00.000Z] [info] committed"]);
});

test("log buffers retain the latest 200 initially and never exceed 2000", async () => {
  const initial = Array.from({ length: 205 }, (_, index) => `initial-${index}`);
  const additions = Array.from({ length: 1905 }, (_, index) => `next-${index}`);
  const http = fakeFetch([
    new Response(transcript("cursor-1", initial), { status: 200 }),
    new Response(transcript("cursor-2", additions), { status: 200 }),
  ]);
  const client = new TuiServerClient("http://score.test", http.request, () => NOW);

  const first = await client.poll();
  expect(first.logs.get("alpha")).toHaveLength(200);
  expect(first.logs.get("alpha")?.[0]).toContain("initial-5");

  const second = await client.poll();
  expect(second.logs.get("alpha")).toHaveLength(2000);
  expect(second.logs.get("alpha")?.at(-1)).toContain("next-1904");
});

test("UTC date rollover clears yesterday's display and advances the since bound", async () => {
  let now = NOW;
  const http = fakeFetch([
    new Response(transcript("cursor-1", ["yesterday"]), { status: 200 }),
    new Response(transcript("cursor-2", ["today"]), { status: 200 }),
  ]);
  const client = new TuiServerClient("http://score.test", http.request, () => now);
  await client.poll();
  now = new Date("2026-08-18T00:00:01.000Z");
  const today = await client.poll();

  expect(today.logs.get("alpha")).toEqual(["[2026-08-17T11:59:00.000Z] [info] today"]);
  expect(http.calls[1]?.url.searchParams.get("since")).toBe("2026-08-18T00:00:00.000Z");
  expect(today.logFile).toBe("2026-08-18.log");
});
