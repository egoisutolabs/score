import { expect, test } from "vitest";
import type { StreamEnvelope } from "./envelope.interface";
import { parseEnvelope, renderEnvelope, streamErrorEnvelope } from "./envelope.render";

test("an envelope round-trips through the SSE wire block", () => {
  const envelope: StreamEnvelope = {
    event: "score.snapshot.project",
    data: { project: "score", health: "running", observed_at: "2026-08-15T00:00:00.000Z" },
    sequence: { score: 3 },
  };
  expect(parseEnvelope(renderEnvelope(envelope))).toEqual(envelope);
});

test("a record envelope carries the segment vocabulary untouched", () => {
  const envelope: StreamEnvelope = {
    event: "score.telemetry.event",
    data: {
      source: "telemetry",
      record: {
        version: 1,
        kind: "event",
        time: "2026-08-15T00:00:01.000Z",
        name: "score.dispatch.decision",
        resource: { project: "score" },
      },
    },
  };
  expect(parseEnvelope(renderEnvelope(envelope))).toEqual(envelope);
});

test("a caught-up envelope round-trips its fleet cursor", () => {
  const envelope: StreamEnvelope = {
    event: "score.stream.caught_up",
    data: {
      through: {
        "score|telemetry": {
          project: "score",
          source: "telemetry",
          segment: "2026-08-15",
          byte_offset: 42,
        },
      },
      follow: true,
    },
  };
  expect(parseEnvelope(renderEnvelope(envelope))).toEqual(envelope);
});

test("the wire block carries id, event, and data lines, then a blank line", () => {
  const block = renderEnvelope({
    event: "score.stream.caught_up",
    data: { through: {}, follow: true },
    sequence: { score: 1 },
  });
  expect(block.split("\n")).toEqual([
    "id: eyJzY29yZSI6MX0=",
    "event: score.stream.caught_up",
    'data: {"through":{},"follow":true}',
    "",
    "",
  ]);
});

test("data split across wire lines joins into one payload", () => {
  // The SSE spec delivers each data: line's content joined with newlines;
  // JSON allows newlines between tokens, so pretty-printed payloads must
  // reassemble — the parser joins before parsing, never per-line.
  const block = 'event: score.telemetry.event\ndata: {\ndata: "a": 1\ndata: }\n\n';
  expect(parseEnvelope(block)).toEqual({ event: "score.telemetry.event", data: { a: 1 } });
});

test("an error envelope renders only its reason code — no internals escape", () => {
  const block = renderEnvelope(streamErrorEnvelope("cursor-expired"));
  expect(block).toBe('event: score.stream.error\ndata: {"reason_code":"cursor-expired"}\n\n');
});

test("non-frame input parses to undefined", () => {
  for (const block of [
    "",
    "event: score.stream.error\n",
    "data: not json\n",
    "junk: x\ndata: 1\n",
  ]) {
    expect(parseEnvelope(block)).toBeUndefined();
  }
});

test("an event name outside the closed v1 set is not ours", () => {
  expect(parseEnvelope("event: other.system.event\ndata: {}\n")).toBeUndefined();
});
