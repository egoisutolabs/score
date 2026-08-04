import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultClaudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

/**
 * Claude Code's per-folder trust dialog blocks a detached tmux agent forever —
 * nobody is attached to press yes. Trust is recorded per absolute path in
 * ~/.claude.json, so seeding the worktree's entry before launch skips the
 * dialog. This is an unsupported schema: if Claude Code changes it, the dialog
 * simply comes back and the agent stalls — it fails safe, nothing breaks.
 *
 * The file is never created or rewritten from a state we couldn't parse; a
 * corrupt write here would break every Claude session on the machine, so any
 * doubt throws instead.
 */
export async function preseedWorktreeTrust(
  worktreePath: string,
  configPath: string = defaultClaudeConfigPath(),
): Promise<void> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new Error(`${configPath} not found — run claude once interactively to create it`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${configPath} is not valid JSON; refusing to rewrite it: ${String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${configPath} is not a JSON object; refusing to rewrite it`);
  }
  const projects = parsed.projects === undefined ? {} : parsed.projects;
  if (!isRecord(projects)) {
    throw new Error(`${configPath} projects is not a JSON object; refusing to rewrite it`);
  }
  const entry = isRecord(projects[worktreePath]) ? (projects[worktreePath] as object) : {};
  if ((entry as Record<string, unknown>).hasTrustDialogAccepted === true) return;

  parsed.projects = { ...projects, [worktreePath]: { ...entry, hasTrustDialogAccepted: true } };
  // Write-then-rename so a crash mid-write can't leave a torn ~/.claude.json.
  const temporaryPath = `${configPath}.score-trust-tmp`;
  await writeFile(temporaryPath, JSON.stringify(parsed, null, 2));
  await rename(temporaryPath, configPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
