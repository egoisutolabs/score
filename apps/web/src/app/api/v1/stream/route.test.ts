import { expect, test } from "vitest";
import { dynamic, GET, runtime } from "./route";

test("handshake: text/event-stream carrying exactly one score.stream.hello envelope", async () => {
  const res = GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  // res.text() resolving is the clean close: the body is finite and ends
  // after the single frame's blank-line terminator.
  const text = await res.text();
  const frame = /^event: score\.stream\.hello\ndata: (.+)\n\n$/.exec(text);
  expect(frame).not.toBeNull();
  expect(text.match(/^event: /gm)).toHaveLength(1);

  const body = JSON.parse((frame as RegExpExecArray)[1] as string);
  expect(body.api_version).toBe("v1");
  expect(body.data).toEqual({});
  expect(body.warnings).toBeUndefined();
  expect(body.stream_id).not.toBe("");
  expect(new Date(body.emitted_at).toISOString()).toBe(body.emitted_at);
});

test("route is dynamic on the node runtime", () => {
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");
});
