import { expect, test } from "vitest";
import { DEFAULT_UI_PORT, parseUiArguments, resolveWebDir } from "./ui.run";

test("no flags default to a port off Next's 3000", () => {
  expect(parseUiArguments([])).toEqual({ port: DEFAULT_UI_PORT });
  expect(DEFAULT_UI_PORT).not.toBe(3000);
});

test("--port overrides the default", () => {
  expect(parseUiArguments(["--port", "8080"])).toEqual({ port: 8080 });
});

test("--port requires a value", () => {
  expect(() => parseUiArguments(["--port"])).toThrow("--port requires a value");
  expect(() => parseUiArguments(["--port", "--nope"])).toThrow("--port requires a value");
});

test("--port rejects values that are not a port", () => {
  for (const bad of ["nope", "0", "70000", "80.5"]) {
    expect(() => parseUiArguments(["--port", bad])).toThrow("--port must be an integer");
  }
});

test("unknown arguments throw the exit-2 'unknown flag' convention", () => {
  expect(() => parseUiArguments(["--nope"])).toThrow("unknown flag: --nope");
  expect(() => parseUiArguments(["extra"])).toThrow("unknown flag: extra");
});

test("webDir resolves to apps/web from both the source and the built entry", () => {
  expect(resolveWebDir("/opt/score/apps/daemon/src/index.ts")).toBe("/opt/score/apps/web");
  expect(resolveWebDir("/opt/score/apps/daemon/dist/index.js")).toBe("/opt/score/apps/web");
});
