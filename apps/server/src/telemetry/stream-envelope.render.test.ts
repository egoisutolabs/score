import { expect, test } from "vitest";
import { HELLO_EVENT } from "./stream-envelope.interface";
import { envelope, sseFrame } from "./stream-envelope.render";

test("envelope JSON round-trips byte-identical, with and without warnings", () => {
  const bare = envelope({ hello: true });
  expect(JSON.parse(JSON.stringify(bare))).toEqual(bare);
  // No `warnings: undefined` key smuggled in — it would not survive JSON.
  expect("warnings" in bare).toBe(false);

  const warned = envelope(null, [{ reason: "CONFIG_UNPARSEABLE" }]);
  expect(JSON.parse(JSON.stringify(warned))).toEqual(warned);
  expect(warned.warnings).toEqual([{ reason: "CONFIG_UNPARSEABLE" }]);
});

test("envelope carries the v1 constants, a fresh stream_id, and an RFC 3339 emitted_at", () => {
  const first = envelope({});
  expect(first.api_version).toBe("v1");
  expect(first.cursor).toBe("");
  expect(first.stream_id).not.toBe("");
  expect(new Date(first.emitted_at).toISOString()).toBe(first.emitted_at);
  expect(envelope({}).stream_id).not.toBe(first.stream_id);
});

test("sseFrame renders one named event with the envelope as data", () => {
  const body = envelope({});
  expect(sseFrame(HELLO_EVENT, body)).toBe(
    `event: score.stream.hello\ndata: ${JSON.stringify(body)}\n\n`,
  );
});
