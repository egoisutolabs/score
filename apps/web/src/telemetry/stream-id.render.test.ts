import { expect, test } from "vitest";
import { parseStreamId, renderStreamId } from "./stream-id.render";

test("a sequence map round-trips through the wire id", () => {
  const sequence = { score: 119 };
  expect(parseStreamId(renderStreamId(sequence))).toEqual(sequence);
});

test("the rendered id is the base64 JSON the wire contract promises", () => {
  expect(renderStreamId({ score: 119 })).toBe("eyJzY29yZSI6MTE5fQ==");
});

test("an empty sequence renders and parses back", () => {
  expect(parseStreamId(renderStreamId({}))).toEqual({});
});

test("anything the wire never carried parses to undefined", () => {
  for (const id of ["", "!!", "bnVsbA==", "W10=", "MTIz", "eyJhIjoiYiJ9"]) {
    expect(parseStreamId(id)).toBeUndefined();
  }
});
