import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONFIG_TEMPLATE, runConfigInit } from "@/features/config/template";

const originalScoreHome = process.env.SCORE_HOME;
let home: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  home = join(await mkdtemp(join(tmpdir(), "score-init-")), "state");
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

test("fresh init writes the template (creating ~/.score) and exits 0", async () => {
  await runConfigInit();
  const path = join(home, "config.jsonc");
  expect(await readFile(path, "utf8")).toBe(CONFIG_TEMPLATE);
  expect(logs).toEqual([`wrote ${path}`]);
  expect(process.exitCode ?? 0).toBe(0);
});

test("template mentions every config field", () => {
  for (const field of [
    "version",
    "log_retention_days",
    "projects",
    "enabled",
    "main_location",
    "worktree_location",
    "github_repo",
    "tick_interval_ms",
    "max_parallel",
    "harness",
    "model",
    "auto_merge",
  ]) {
    expect(CONFIG_TEMPLATE).toContain(`"${field}"`);
  }
});

test("second init refuses with one line, exit 1, file untouched", async () => {
  await runConfigInit();
  const path = join(home, "config.jsonc");
  const marker = "// operator edits live here\n";
  await writeFile(path, marker);
  await runConfigInit();
  expect(await readFile(path, "utf8")).toBe(marker);
  expect(errors).toEqual([`${path} already exists — not touching it`]);
  expect(process.exitCode).toBe(1);
});
