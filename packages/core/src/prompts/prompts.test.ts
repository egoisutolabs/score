import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  BRIEFING_VERSION,
  IMPLEMENTATION_PROMPT_VERSION,
  promptVersion,
  REPAIR_PROMPT_VERSION,
  REVIEW_RULES,
  REVIEW_RULES_VERSION,
  REVIEWER_PROMPT,
  REVIEWER_PROMPT_VERSION,
  renderImplementationPrompt,
  STRANDED_PING_VERSION,
  STRANDED_RESPAWN_VERSION,
} from "./index";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

test("every prompt has a distinct twelve-hex content version", () => {
  const versions = [
    BRIEFING_VERSION,
    IMPLEMENTATION_PROMPT_VERSION,
    REPAIR_PROMPT_VERSION,
    STRANDED_PING_VERSION,
    STRANDED_RESPAWN_VERSION,
    REVIEWER_PROMPT_VERSION,
    REVIEW_RULES_VERSION,
  ];
  for (const version of versions) expect(version).toMatch(/^[0-9a-f]{12}$/);
  expect(new Set(versions).size).toBe(versions.length);
  // Same text, same version; one character apart, a different one.
  expect(promptVersion("a")).toBe(promptVersion("a"));
  expect(promptVersion("a")).not.toBe(promptVersion("a "));
});

test("the reviewer prompt copy matches the workflow GitHub actually runs", () => {
  const yaml = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "claude-review.yml"),
    "utf8",
  ).split("\n");
  const start = yaml.indexOf("          prompt: |");
  expect(start).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const line of yaml.slice(start + 1)) {
    if (line.trim() === "") {
      block.push("");
      continue;
    }
    if (!line.startsWith("            ")) break;
    block.push(line.slice(12));
  }
  while (block.at(-1) === "") block.pop();
  expect(REVIEWER_PROMPT).toBe(`${block.join("\n")}\n`);
});

test("the review rules copy matches the Code Review Rules section of AGENTS.md", () => {
  const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  const start = agents.indexOf("## Code Review Rules");
  expect(start).toBeGreaterThan(-1);
  expect(REVIEW_RULES).toBe(agents.slice(start));
});

test("the implementation line points at TASK.md and tells the session where to stop", () => {
  const prompt = renderImplementationPrompt();
  expect(prompt).toContain("Read TASK.md");
  expect(prompt).toContain("Fixes in the body");
  expect(prompt).toMatch(/Stop after reporting the PR URL\.$/);
  expect(prompt).not.toContain("\n");
});
