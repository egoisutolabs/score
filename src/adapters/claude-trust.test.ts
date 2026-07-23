import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { preseedWorktreeTrust } from "@/adapters/claude-trust";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function configFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "score-trust-test-"));
  sandboxes.push(root);
  const path = join(root, "claude.json");
  await writeFile(path, content);
  return path;
}

test("seeds trust for a new worktree while preserving everything else", async () => {
  const path = await configFile(
    JSON.stringify({
      numStartups: 42,
      projects: { "/existing": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } },
    }),
  );

  await preseedWorktreeTrust("/worktrees/issue-2-daemon", path);

  const config = JSON.parse(await readFile(path, "utf8"));
  expect(config.numStartups).toBe(42);
  expect(config.projects["/existing"]).toEqual({
    hasTrustDialogAccepted: true,
    allowedTools: ["Bash"],
  });
  expect(config.projects["/worktrees/issue-2-daemon"]).toEqual({ hasTrustDialogAccepted: true });
});

test("merges into an existing project entry without dropping its keys", async () => {
  const path = await configFile(
    JSON.stringify({
      projects: { "/worktrees/issue-2-daemon": { hasTrustDialogAccepted: false, mcpServers: {} } },
    }),
  );

  await preseedWorktreeTrust("/worktrees/issue-2-daemon", path);

  const config = JSON.parse(await readFile(path, "utf8"));
  expect(config.projects["/worktrees/issue-2-daemon"]).toEqual({
    hasTrustDialogAccepted: true,
    mcpServers: {},
  });
});

test("already-trusted worktree leaves the file byte-identical", async () => {
  const original = JSON.stringify({
    projects: { "/worktrees/issue-2-daemon": { hasTrustDialogAccepted: true } },
  });
  const path = await configFile(original);

  await preseedWorktreeTrust("/worktrees/issue-2-daemon", path);

  expect(await readFile(path, "utf8")).toBe(original);
});

test("refuses to touch a missing or unparseable config", async () => {
  await expect(preseedWorktreeTrust("/w", "/nonexistent/claude.json")).rejects.toThrow(
    /not found — run claude once/,
  );

  const corrupt = await configFile("{ definitely not json");
  await expect(preseedWorktreeTrust("/w", corrupt)).rejects.toThrow(/refusing to rewrite/);
  expect(await readFile(corrupt, "utf8")).toBe("{ definitely not json");
});
