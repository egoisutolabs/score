import { expect, test } from "vitest";
import type { StreamEnvelope, StreamErrorData } from "./envelope.interface";
import { parseEnvelope, renderEnvelope, streamErrorEnvelope } from "./envelope.render";

// The discriminated union is the compile-time proof: each expect-error says
// "this mismatched envelope must not typecheck". If the union ever loosens,
// tsc fails here on the unused directive — the guard cannot silently rot.
const snapshotData = {
  project: "score",
  health: "running",
  observed_at: "2026-08-15T00:00:00.000Z",
};
// @ts-expect-error — an error name must not carry snapshot data
const mismatched: StreamEnvelope = { event: "score.stream.error", data: snapshotData };
// @ts-expect-error — a reserved metric name has no v1 payload at all
const metric: StreamEnvelope = { event: "score.telemetry.metric", data: snapshotData };
// @ts-expect-error — a span name must carry a span record, not an event record
const wrongKind: StreamEnvelope = {
  event: "score.telemetry.span",
  data: {
    source: "telemetry",
    record: {
      version: 1,
      kind: "event",
      time: "2026-08-15T00:00:00.000Z",
      name: "score.x.y",
      resource: { project: "score" },
    },
  },
};

test("mismatched envelopes are compile-time errors, never rendered", () => {
  expect([mismatched, metric, wrongKind]).toHaveLength(3); // referenced so tsc keeps them
});

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
  const block = [
    "event: score.stream.caught_up",
    "data: {",
    'data:   "through": {},',
    'data:   "follow": true',
    "data: }",
    "",
  ].join("\n");
  expect(parseEnvelope(block)).toEqual({
    event: "score.stream.caught_up",
    data: { through: {}, follow: true },
  });
});

test("an error envelope renders only its reason code — no internals escape", () => {
  const block = renderEnvelope(streamErrorEnvelope("cursor-expired"));
  expect(block).toBe('event: score.stream.error\ndata: {"reason_code":"cursor-expired"}\n\n');
});

test("error frames strip fields structural typing let through", () => {
  // A spread variable keeps excess keys assignable — the renderer's error
  // projection, not the type, must keep them off the wire.
  const smuggled = {
    ...streamErrorEnvelope("internal").data,
    stack: "at secret/path.ts:1:1",
    path: "/home/operator",
  } as StreamErrorData;
  const block = renderEnvelope({ event: "score.stream.error", data: smuggled });
  expect(block).toBe('event: score.stream.error\ndata: {"reason_code":"internal"}\n\n');
  expect(parseEnvelope(block)?.data).toEqual({ reason_code: "internal" });
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

test("a span envelope round-trips with its required span_id", () => {
  const envelope: StreamEnvelope = {
    event: "score.telemetry.span",
    data: {
      source: "telemetry",
      record: {
        version: 1,
        kind: "span",
        time: "2026-08-15T00:00:01.000Z",
        name: "score.tick",
        resource: { project: "score" },
        span_id: "4df7a1b2c3d4",
        parent_span_id: "963a00000000",
        duration_ms: 42,
        status: "ok",
      },
    },
    sequence: { score: 7 },
  };
  expect(parseEnvelope(renderEnvelope(envelope))).toEqual(envelope);
});

test("a record with optional base fields populated round-trips", () => {
  const envelope: StreamEnvelope = {
    event: "score.telemetry.event",
    data: {
      source: "telemetry",
      record: {
        version: 1,
        kind: "event",
        time: "2026-08-15T00:00:01.000Z",
        name: "score.dispatch.decision",
        resource: { project: "score", daemon_pid: 4242 },
        subject: { session: "issue-55", branch: "issue-55-x", issue_number: 55 },
        attributes: { reason_code: "capacity_available", attempt: 1, replayed: false },
      },
    },
  };
  expect(parseEnvelope(renderEnvelope(envelope))).toEqual(envelope);
});

test.each([
  ["error frame with a null payload", "score.stream.error", "null"],
  ["error frame with an unknown reason code", "score.stream.error", '{"reason_code":"teapot"}'],
  ["error frame with extra shape drift", "score.stream.error", '{"reason":1}'],
  [
    "snapshot missing observed_at",
    "score.snapshot.project",
    '{"project":"score","health":"running"}',
  ],
  [
    "record payload with a version the reader skips",
    "score.telemetry.event",
    '{"source":"telemetry","record":{"version":2,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y","resource":{"project":"score"}}}',
  ],
  [
    "record payload without a resource",
    "score.telemetry.event",
    '{"source":"telemetry","record":{"version":1,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y"}}',
  ],
  [
    "record payload with a non-record subject",
    "score.telemetry.event",
    '{"source":"telemetry","record":{"version":1,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y","resource":{"project":"score"},"subject":7}}',
  ],
  [
    "record payload with a null attributes value",
    "score.telemetry.event",
    '{"source":"telemetry","record":{"version":1,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y","resource":{"project":"score"},"attributes":null}}',
  ],
  [
    "record payload with a nested attribute value",
    "score.telemetry.event",
    '{"source":"telemetry","record":{"version":1,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y","resource":{"project":"score"},"attributes":{"nested":{"deep":1}}}}',
  ],
  [
    "record payload with a string daemon_pid",
    "score.telemetry.event",
    '{"source":"telemetry","record":{"version":1,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y","resource":{"project":"score","daemon_pid":"4242"}}}',
  ],
  [
    "record payload with a non-string session subject",
    "score.telemetry.event",
    '{"source":"telemetry","record":{"version":1,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y","resource":{"project":"score"},"subject":{"session":55}}}',
  ],
  [
    "span payload carrying an event record",
    "score.telemetry.span",
    '{"source":"telemetry","record":{"version":1,"kind":"event","time":"2026-08-15T00:00:00.000Z","name":"score.x.y","resource":{"project":"score"}}}',
  ],
  [
    "span payload missing span_id",
    "score.telemetry.span",
    '{"source":"telemetry","record":{"version":1,"kind":"span","time":"2026-08-15T00:00:00.000Z","name":"score.tick","resource":{"project":"score"}}}',
  ],
  [
    "span payload with a non-string span_id",
    "score.telemetry.span",
    '{"source":"telemetry","record":{"version":1,"kind":"span","time":"2026-08-15T00:00:00.000Z","name":"score.tick","resource":{"project":"score"},"span_id":7}}',
  ],
  [
    "span payload with a non-string parent_span_id",
    "score.telemetry.span",
    '{"source":"telemetry","record":{"version":1,"kind":"span","time":"2026-08-15T00:00:00.000Z","name":"score.tick","resource":{"project":"score"},"span_id":"a1","parent_span_id":2}}',
  ],
  [
    "span payload with a non-numeric duration_ms",
    "score.telemetry.span",
    '{"source":"telemetry","record":{"version":1,"kind":"span","time":"2026-08-15T00:00:00.000Z","name":"score.tick","resource":{"project":"score"},"span_id":"a1","duration_ms":"42"}}',
  ],
  [
    "span payload with an unknown status",
    "score.telemetry.span",
    '{"source":"telemetry","record":{"version":1,"kind":"span","time":"2026-08-15T00:00:00.000Z","name":"score.tick","resource":{"project":"score"},"span_id":"a1","status":"teapot"}}',
  ],
  [
    "caught-up payload that does not follow",
    "score.stream.caught_up",
    '{"through":{},"follow":false}',
  ],
  [
    "caught-up cursor with a foreign source",
    "score.stream.caught_up",
    '{"through":{"k":{"project":"score","source":"otlp","segment":"2026-08-15","byte_offset":0}},"follow":true}',
  ],
  [
    "caught-up cursor with a negative byte_offset",
    "score.stream.caught_up",
    '{"through":{"k":{"project":"score","source":"telemetry","segment":"2026-08-15","byte_offset":-1}},"follow":true}',
  ],
  [
    "caught-up cursor with a fractional byte_offset",
    "score.stream.caught_up",
    '{"through":{"k":{"project":"score","source":"telemetry","segment":"2026-08-15","byte_offset":1.5}},"follow":true}',
  ],
  [
    "caught-up cursor with a non-dated segment",
    "score.stream.caught_up",
    '{"through":{"k":{"project":"score","source":"telemetry","segment":"zzzz","byte_offset":0}},"follow":true}',
  ],
  [
    "caught-up cursor with an impossible calendar stamp",
    "score.stream.caught_up",
    '{"through":{"k":{"project":"score","source":"telemetry","segment":"9999-99-99","byte_offset":0}},"follow":true}',
  ],
  [
    "caught-up cursor with a February 30 stamp",
    "score.stream.caught_up",
    '{"through":{"k":{"project":"score","source":"telemetry","segment":"2026-02-30","byte_offset":0}},"follow":true}',
  ],
  [
    "caught-up cursor with a zero month",
    "score.stream.caught_up",
    '{"through":{"k":{"project":"score","source":"telemetry","segment":"2026-00-15","byte_offset":0}},"follow":true}',
  ],
  ["reserved metric name with no payload vocabulary", "score.telemetry.metric", "{}"],
  ["reserved log name with no payload vocabulary", "score.telemetry.log", "{}"],
])("malformed frame: %s", (_name, event, data) => {
  expect(parseEnvelope(`event: ${event}\ndata: ${data}\n`)).toBeUndefined();
});
