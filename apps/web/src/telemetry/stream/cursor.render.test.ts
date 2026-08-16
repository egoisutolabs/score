import { expect, test } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.render";

const components = [
  { project: "score", source: "telemetry" as const, segment: "2026-08-15", byte_offset: 120 },
  { project: "score", source: "log" as const, segment: "2026-08-15", byte_offset: 0 },
  { project: "other", source: "telemetry" as const, segment: "2026-08-14", byte_offset: 7 },
];

test("composite cursor round-trips every component", () => {
  expect(decodeCursor(encodeCursor(components))).toEqual(components);
});

test("garbage and mis-shaped cursors decode to undefined, never throw", () => {
  for (const value of [
    "",
    "not base64!!",
    Buffer.from("[1,2]").toString("base64url"),
    Buffer.from('{"project":"score"}').toString("base64url"),
    Buffer.from(
      '[{"project":"score","source":"db","segment":"2026-08-15","byte_offset":0}]',
    ).toString("base64url"),
    Buffer.from(
      '[{"project":"score","source":"telemetry","segment":"today","byte_offset":0}]',
    ).toString("base64url"),
    Buffer.from(
      '[{"project":"score","source":"telemetry","segment":"2026-08-15","byte_offset":-1}]',
    ).toString("base64url"),
    Buffer.from(
      '[{"project":"score","source":"telemetry","segment":"2026-08-15","byte_offset":1.5}]',
    ).toString("base64url"),
  ]) {
    expect(decodeCursor(value)).toBeUndefined();
  }
});
