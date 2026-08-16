import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DELETE, dynamic, GET, PATCH, POST, PUT, runtime } from "./route";

// The route reads SCORE_HOME at request time; each test points it at a fresh
// sandbox. Stream semantics and golden transcripts live in
// src/telemetry/stream/; this file covers the HTTP shaping: verbs, statuses,
// headers, and the enum-only error payloads.
let root: string;
const savedHome = process.env.SCORE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "score-stream-route-"));
  process.env.SCORE_HOME = root;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

function seed(relative: string, text: string): void {
  const path = join(root, "projects", relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function get(search = "", headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request(`http://127.0.0.1/api/v1/stream${search}`, { headers }));
}

test("subscribe streams SSE from hello to a clean close", async () => {
  seed("alpha/resolved.json", '{"key":"alpha"}');
  seed(
    "alpha/telemetry/2026-08-15.jsonl",
    '{"v":1,"ts":"2026-08-15T11:59:01.000Z","project":"alpha","signal":"event","name":"score.daemon.started"}\n',
  );
  const res = await get("?projects=alpha&follow=false");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-store");

  // text() resolving is the clean close: the body is finite in this PR.
  const text = await res.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  expect(events[0]).toBe("score.stream.hello");
  expect(events).toContain("score.telemetry.event");
  expect(events.at(-1)).toBe("score.stream.caught_up");
  expect(text).not.toContain(root);
});

test("unknown filter → 400 with only the enum reason", async () => {
  const res = await get("?verbose=1");
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(JSON.parse(text).warnings).toEqual([{ reason: "FILTER_UNKNOWN" }]);
  expect(text).not.toContain(root);
});

test("undecodable Last-Event-ID → 400 CURSOR_UNPARSEABLE", async () => {
  const res = await get("", { "last-event-id": "garbage" });
  expect(res.status).toBe(400);
  expect(JSON.parse(await res.text()).warnings).toEqual([{ reason: "CURSOR_UNPARSEABLE" }]);
});

test("cursor naming a deleted segment → 410 before any event", async () => {
  seed(
    "alpha/telemetry/2026-08-15.jsonl",
    '{"v":1,"ts":"2026-08-15T11:59:01.000Z","project":"alpha","signal":"event","name":"score.daemon.started"}\n',
  );
  const expired = Buffer.from(
    JSON.stringify([
      { project: "alpha", source: "telemetry", segment: "2026-08-01", byte_offset: 0 },
    ]),
  ).toString("base64url");
  const res = await get("?projects=alpha", { "last-event-id": expired });
  expect(res.status).toBe(410);
  const body = JSON.parse(await res.text());
  expect(body.warnings).toEqual([{ reason: "CURSOR_EXPIRED" }]);
  expect(body.data).toBeNull();
});

test("mutating verbs → 405, GET-only surface", () => {
  for (const handler of [POST, PUT, PATCH, DELETE]) {
    const res = handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  }
});

test("route is dynamic on the node runtime", () => {
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");
});
