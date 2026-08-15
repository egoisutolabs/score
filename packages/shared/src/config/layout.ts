import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Root of Score's state: `SCORE_HOME` if set, else `~/.score`. Always
 * absolute: a relative SCORE_HOME would name a different directory in every
 * process cwd — the supervisor writes state from the operator's shell while
 * the daemon it starts runs in the project checkout.
 */
export function scoreHome(): string {
  const home = process.env.SCORE_HOME;
  return home ? resolve(home) : join(homedir(), ".score");
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

export function telemetryDir(key: string): string {
  return join(projectDir(key), "telemetry");
}

export function promptsDir(key: string): string {
  return join(projectDir(key), "prompts");
}

export function crashLogPath(key: string): string {
  return join(projectDir(key), "launchd-crash.log");
}
