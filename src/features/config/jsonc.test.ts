import { expect, test } from "vitest";

import { parseJsonc } from "@/features/config/jsonc";

test("strips line comments at line end and line start", () => {
  expect(
    parseJsonc(`// leading comment
{
  "a": 1, // trailing comment
  "b": 2
}`),
  ).toEqual({ a: 1, b: 2 });
});

test("strips block comments, including multi-line", () => {
  expect(
    parseJsonc(`{ /* one */ "a": /* two
  lines */ 1 }`),
  ).toEqual({ a: 1 });
});

test("comment markers inside strings survive parsing", () => {
  expect(parseJsonc(`{ "a": "// not a comment" }`)).toEqual({ a: "// not a comment" });
  expect(parseJsonc(`{ "a": "/* nope */", "b": "*/" }`)).toEqual({ a: "/* nope */", b: "*/" });
});

test("escaped quote inside a string does not end the string", () => {
  expect(parseJsonc(`{ "a": "quote \\" then // still string" }`)).toEqual({
    a: 'quote " then // still string',
  });
});

test("allows trailing commas in objects and arrays", () => {
  expect(parseJsonc(`{ "a": [1, 2, 3,], "b": { "c": 1, }, }`)).toEqual({
    a: [1, 2, 3],
    b: { c: 1 },
  });
});

test("trailing comma before a comment before the closing brace", () => {
  expect(
    parseJsonc(`{
  "a": 1, // last entry
}`),
  ).toEqual({ a: 1 });
});

test("a block comment splitting a token does not fuse it into a valid value", () => {
  expect(() => parseJsonc(`{ "a": 60/* seconds */000 }`)).toThrow();
  expect(() => parseJsonc(`{ "a": tr/*x*/ue }`)).toThrow();
});

test("a block comment between tokens still leaves valid JSONC", () => {
  expect(parseJsonc(`{ "a"/* key */: 1 }`)).toEqual({ a: 1 });
});

test("leading and doubled commas are rejected, not tolerated", () => {
  expect(() => parseJsonc(`{ "a": {,} }`)).toThrow();
  expect(() => parseJsonc(`{ "a": [,] }`)).toThrow();
  expect(() => parseJsonc(`[1,,]`)).toThrow();
});

test("nested combinations", () => {
  expect(
    parseJsonc(`{
  /* header */
  "outer": {
    "list": [
      { "url": "https://example.com//path", }, // keeps the double slash
    ],
  },
}`),
  ).toEqual({ outer: { list: [{ url: "https://example.com//path" }] } });
});

test("a truncated file fails fast instead of loading the recoverable prefix", () => {
  expect(() => parseJsonc('{ "version": 1, "projects": {} } /* cut off')).toThrow(
    /UnexpectedEndOfComment/,
  );
  expect(() => parseJsonc('{ "version": 1, "projects": {')).toThrow();
  // A properly closed comment in the same position still parses cleanly.
  expect(parseJsonc('{ "version": 1 } /* closed */')).toEqual({ version: 1 });
});
