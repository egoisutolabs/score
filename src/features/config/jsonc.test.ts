import { expect, test } from "vitest";
import { stripJsonc } from "@/features/config/jsonc";

function parse(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

test("strips line comments at line end and line start", () => {
  expect(
    parse(`// leading comment
{
  "a": 1, // trailing comment
  "b": 2
}`),
  ).toEqual({ a: 1, b: 2 });
});

test("strips block comments, including multi-line", () => {
  expect(
    parse(`{ /* one */ "a": /* two
  lines */ 1 }`),
  ).toEqual({ a: 1 });
});

test("// inside a string survives stripping", () => {
  expect(parse(`{ "a": "// not a comment" }`)).toEqual({ a: "// not a comment" });
});

test("block-comment markers inside strings survive stripping", () => {
  expect(parse(`{ "a": "/* nope */", "b": "*/" }`)).toEqual({ a: "/* nope */", b: "*/" });
});

test("escaped quote inside a string does not end the string", () => {
  expect(parse(`{ "a": "quote \\" then // still string" }`)).toEqual({
    a: 'quote " then // still string',
  });
});

test("removes trailing commas in objects and arrays", () => {
  expect(parse(`{ "a": [1, 2, 3,], "b": { "c": 1, }, }`)).toEqual({ a: [1, 2, 3], b: { c: 1 } });
});

test("trailing comma before a comment before the closing brace", () => {
  expect(
    parse(`{
  "a": 1, // last entry
}`),
  ).toEqual({ a: 1 });
});

test("comma inside a string is untouched", () => {
  expect(parse(`{ "a": "x,}" }`)).toEqual({ a: "x,}" });
});

test("a block comment splitting a token does not fuse it into valid JSON", () => {
  expect(() => parse(`{ "a": 60/* seconds */000 }`)).toThrow();
  expect(() => parse(`{ "a": tr/*x*/ue }`)).toThrow();
});

test("a block comment between tokens still leaves valid JSON", () => {
  expect(parse(`{ "a"/* key */: 1 }`)).toEqual({ a: 1 });
});

test("leading commas in empty containers are rejected, not stripped", () => {
  expect(() => parse(`{ "a": {,} }`)).toThrow();
  expect(() => parse(`{ "a": [,] }`)).toThrow();
  expect(() => parse(`[1,,]`)).toThrow();
});

test("nested combinations", () => {
  expect(
    parse(`{
  /* header */
  "outer": {
    "list": [
      { "url": "https://example.com//path", }, // keeps the double slash
    ],
  },
}`),
  ).toEqual({ outer: { list: [{ url: "https://example.com//path" }] } });
});
