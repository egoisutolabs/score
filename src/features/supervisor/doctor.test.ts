import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runConfigInit } from "@/features/config/template";
import { runDoctor } from "@/features/supervisor/doctor";

const originalScoreHome = process.env.SCORE_HOME;
let home: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  home = join(await mkdtemp(join(tmpdir(), "score-doctor-")), "state");
  process.env.SCORE_HOME = home;
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => errors.push(line));
});

afterEach(() => {
  if (originalScoreHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = originalScoreHome;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function project(enabled: boolean): string {
  return `{
    "enabled": ${enabled},
    "main_location": "~/code/x",
    "worktree_location": "~/wt/x",
    "github_repo": "owner/x",
    "config": { "agent": { "harness": "claude", "model": "claude-sonnet-5" } }
  }`;
}

async function writeConfig(text: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.jsonc"), text);
}

test("valid config: ok line with project and enabled counts, exit 0", async () => {
  await writeConfig(
    `{ "version": 1, "projects": { "a": ${project(true)}, "b": ${project(false)} } }`,
  );
  await runDoctor();
  expect(logs).toEqual(["config ok (2 projects, 1 enabled)"]);
  expect(errors).toEqual([]);
  expect(process.exitCode ?? 0).toBe(0);
});

test("invalid config: loader's field-path error, exit 1", async () => {
  await writeConfig(`{ "version": 1, "projects": { "a": { "enabled": "yes" } } }`);
  await runDoctor();
  expect(errors).toEqual([expect.stringMatching(/config is invalid: .*projects\.a\.enabled/)]);
  expect(process.exitCode).toBe(1);
});

test("unparseable config: JSONC error, exit 1", async () => {
  await writeConfig("{ not json\n");
  await runDoctor();
  expect(errors).toEqual([expect.stringMatching(/config is invalid: .*not valid JSONC/)]);
  expect(process.exitCode).toBe(1);
});

test("missing config points at score config init, exit 1", async () => {
  await runDoctor();
  expect(errors).toEqual([expect.stringContaining("no config at")]);
  expect(errors[0]).toContain("score config init");
  expect(process.exitCode).toBe(1);
});

test("config init then doctor: template validates as-is", async () => {
  await runConfigInit();
  await runDoctor();
  expect(logs).toEqual([
    `wrote ${join(home, "config.jsonc")}`,
    "config ok (0 projects, 0 enabled)",
  ]);
  expect(process.exitCode ?? 0).toBe(0);
});
