import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  configPath,
  crashLogPath,
  logsDir,
  projectDir,
  promptsDir,
  resolvedPath,
  scoreHome,
  statusPath,
} from "@/features/config/layout";

const originalScoreHome = process.env.SCORE_HOME;

afterEach(() => {
  if (originalScoreHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = originalScoreHome;
});

test("scoreHome defaults to ~/.score", () => {
  delete process.env.SCORE_HOME;
  expect(scoreHome()).toBe(join(homedir(), ".score"));
});

test("every layout path lands under SCORE_HOME when set", () => {
  process.env.SCORE_HOME = "/tmp/x";
  expect(scoreHome()).toBe("/tmp/x");
  expect(configPath()).toBe("/tmp/x/config.jsonc");
  expect(projectDir("score")).toBe("/tmp/x/projects/score");
  expect(resolvedPath("score")).toBe("/tmp/x/projects/score/resolved.json");
  expect(statusPath("score")).toBe("/tmp/x/projects/score/status.json");
  expect(logsDir("score")).toBe("/tmp/x/projects/score/logs");
  expect(promptsDir("score")).toBe("/tmp/x/projects/score/prompts");
  expect(crashLogPath("score")).toBe("/tmp/x/projects/score/launchd-crash.log");
});
