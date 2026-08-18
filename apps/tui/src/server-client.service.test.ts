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

function decision(pullRequest: number, ts = "2026-08-17T11:58:00.000Z", tag = "merged"): unknown {
  return {
    v: 1,
    signal: "event",
    project: "alpha",
    ts,
    name: "score.landing.decision",
    subject: { pull_request_number: pullRequest },
    attributes: { tag, dry_run: false },
  };
}

function transcript(
  cursor: string,
  lines: readonly string[] = [],
  events: readonly unknown[] = [],
): string {
  return (
    frame("score.stream.hello", {}, "") +
    frame("score.snapshot.project", project("alpha"), "") +
    events.map((event) => frame("score.telemetry.event", event, cursor)).join("") +
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

function history(merges: readonly unknown[] = [], warnings: readonly string[] = []): Response {
  return new Response(
    JSON.stringify({
      api_version: "v1",
      emitted_at: NOW.toISOString(),
      stream_id: "history-1",
      cursor: "",
      data: merges,
      ...(warnings.length > 0 && { warnings: warnings.map((reason) => ({ reason })) }),
    }),
    { status: 200 },
  );
}

const githubMerge = (pullRequest: number, mergedAt = "2026-08-17T11:58:30.000Z") => ({
  project: "alpha",
  pull_request_number: pullRequest,
  title: `Merge ${pullRequest}`,
  merged_at: mergedAt,
});

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

test("poll maps snapshots, history, and logs, then resumes from caught_up", async () => {
  const http = fakeFetch([
    new Response(transcript("cursor-1", ["tick started"], [decision(41)]), { status: 200 }),
    history([githubMerge(103)]),
    new Response(transcript("cursor-2", ["tick complete"]), { status: 200 }),
    history([githubMerge(103)]),
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
  expect(first.history).toEqual([
    {
      project: "alpha",
      ts: "2026-08-17T11:58:00.000Z",
      name: "score.landing.decision",
      subject: { pull_request_number: 41 },
      attributes: { tag: "merged", dry_run: false },
    },
  ]);
  expect(http.calls[0]?.url.searchParams.get("signals")).toBe("snapshot,event,log");
  expect(http.calls[0]?.url.searchParams.get("follow")).toBe("false");
  expect(http.calls[0]?.url.searchParams.get("since")).toBe("2026-08-17T00:00:00.000Z");
  expect(http.calls[0]?.headers.get("last-event-id")).toBeNull();
  expect(http.calls[1]?.url.pathname).toBe("/api/v1/history");
  expect(http.calls[1]?.url.searchParams.get("since")).toBe("2026-07-19T00:00:00.000Z");
  expect(first.githubMerges).toEqual([
    {
      project: "alpha",
      pullRequest: 103,
      title: "Merge 103",
      mergedTs: "2026-08-17T11:58:30.000Z",
    },
  ]);

  const second = await client.poll();
  expect(http.calls[2]?.headers.get("last-event-id")).toBe("cursor-1");
  expect(second.logs.get("alpha")).toEqual([
    "[2026-08-17T11:59:00.000Z] [info] tick started",
    "[2026-08-17T11:59:00.000Z] [info] tick complete",
  ]);
});

test("snapshot warnings stay explicit while usable data still renders", async () => {
  const body =
    frame("score.snapshot.project", project("alpha", "stale"), "", ["SUPERVISOR_UNREADABLE"]) +
    frame("score.stream.caught_up", {}, "cursor-1");
  const http = fakeFetch([new Response(body, { status: 200 }), history()]);
  const state = await new TuiServerClient("http://score.test", http.request, () => NOW).poll();

  expect(state.projects[0]?.dot).toBe("amber");
  expect(state.warnings).toEqual(["SUPERVISOR_UNREADABLE"]);
});

test("an older server without the history route is identified precisely", async () => {
  const http = fakeFetch([
    new Response(transcript("cursor-1"), { status: 200 }),
    new Response("Cannot GET /api/v1/history", { status: 404 }),
  ]);
  const state = await new TuiServerClient("http://score.test", http.request, () => NOW).poll();

  expect(state.githubMerges).toEqual([]);
  expect(state.warnings).toEqual(["SERVER_HISTORY_UNAVAILABLE"]);
});

test("an expired cursor clears buffered telemetry and retries without Last-Event-ID", async () => {
  const expired = JSON.stringify({
    api_version: "v1",
    cursor: "",
    data: null,
    warnings: [{ reason: "CURSOR_EXPIRED" }],
  });
  const http = fakeFetch([
    new Response(transcript("cursor-1", ["old"], [decision(40)]), { status: 200 }),
    history([githubMerge(40)]),
    new Response(expired, { status: 410 }),
    new Response(transcript("cursor-2", ["fresh"], [decision(41)]), { status: 200 }),
    history([githubMerge(41)]),
  ]);
  const client = new TuiServerClient("http://score.test", http.request, () => NOW);
  await client.poll();
  const recovered = await client.poll();

  expect(http.calls[2]?.headers.get("last-event-id")).toBe("cursor-1");
  expect(http.calls[3]?.headers.get("last-event-id")).toBeNull();
  expect(recovered.logs.get("alpha")).toEqual(["[2026-08-17T11:59:00.000Z] [info] fresh"]);
  expect(recovered.history.map((event) => event.subject?.pull_request_number)).toEqual([41]);
});

test("a response without caught_up is rejected without advancing the cursor", async () => {
  const http = fakeFetch([
    new Response(
      frame("score.snapshot.project", project("alpha"), "cursor-bad") +
        frame("score.telemetry.event", decision(40), "cursor-bad") +
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
    history(),
  ]);
  const client = new TuiServerClient("http://score.test", http.request, () => NOW);

  await expect(client.poll()).rejects.toThrow("server stream ended before score.stream.caught_up");
  const recovered = await client.poll();
  expect(http.calls[1]?.headers.get("last-event-id")).toBeNull();
  expect(recovered.logs.get("alpha")).toEqual(["[2026-08-17T11:59:00.000Z] [info] committed"]);
  expect(recovered.history).toEqual([]);
});

test("log buffers retain the latest 200 initially and never exceed 2000", async () => {
  const initial = Array.from({ length: 205 }, (_, index) => `initial-${index}`);
  const additions = Array.from({ length: 1905 }, (_, index) => `next-${index}`);
  const http = fakeFetch([
    new Response(transcript("cursor-1", initial), { status: 200 }),
    history(),
    new Response(transcript("cursor-2", additions), { status: 200 }),
    history(),
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
    new Response(transcript("cursor-1", ["yesterday"], [decision(40)]), { status: 200 }),
    history([githubMerge(40)]),
    new Response(transcript("cursor-2", ["today"], [decision(41, "2026-08-18T00:00:00.500Z")]), {
      status: 200,
    }),
    history([githubMerge(41, "2026-08-18T00:00:01.000Z")]),
  ]);
  const client = new TuiServerClient("http://score.test", http.request, () => now);
  await client.poll();
  now = new Date("2026-08-18T00:00:01.000Z");
  const today = await client.poll();

  expect(today.logs.get("alpha")).toEqual(["[2026-08-17T11:59:00.000Z] [info] today"]);
  expect(http.calls[2]?.url.searchParams.get("since")).toBe("2026-08-18T00:00:00.000Z");
  expect(http.calls[3]?.url.searchParams.get("since")).toBe("2026-07-20T00:00:00.000Z");
  expect(today.logFile).toBe("2026-08-18.log");
  expect(today.history.map((event) => event.subject?.pull_request_number)).toEqual([41]);
});
