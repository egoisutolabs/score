import { homedir } from "node:os";
import { join } from "node:path";

/** Root of Score's state: `SCORE_HOME` if set, else `~/.score`. */
export function scoreHome(): string {
  return process.env.SCORE_HOME || join(homedir(), ".score");
}

export function configPath(): string {
  return join(scoreHome(), "config.jsonc");
}

export function projectDir(key: string): string {
  return join(scoreHome(), "projects", key);
}

export function resolvedPath(key: string): string {
  return join(projectDir(key), "resolved.json");
}

export function statusPath(key: string): string {
  return join(projectDir(key), "status.json");
}

export function logsDir(key: string): string {
  return join(projectDir(key), "logs");
}

export function promptsDir(key: string): string {
  return join(projectDir(key), "prompts");
}

export function crashLogPath(key: string): string {
  return join(projectDir(key), "launchd-crash.log");
}
