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

test("a crafted unsafe-integer counter parses to undefined", () => {
  // Above MAX_SAFE_INTEGER, incrementing returns the same number — a
  // resume position that can never advance.
  const crafted = Buffer.from('{"score":9007199254740992}', "utf8").toString("base64");
  expect(parseStreamId(crafted)).toBeUndefined();
});

test("rendering refuses counters the wire would reject", () => {
  for (const bad of [
    { score: -1 },
    { score: 1.5 },
    { score: Number.POSITIVE_INFINITY },
    { score: Number.NaN },
    { score: 9007199254740992 },
  ]) {
    expect(() => renderStreamId(bad)).toThrow(/safe nonnegative integer/);
  }
});
