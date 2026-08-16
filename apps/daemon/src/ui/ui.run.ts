import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scoreHome } from "@score/shared/config/layout";

/** Not Next's default 3000 — the console must not squat the port every local dev server assumes free. */
export const DEFAULT_UI_PORT = 3111;

export interface UiArguments {
  readonly port: number;
}

export function parseUiArguments(args: readonly string[]): UiArguments {
  let port = DEFAULT_UI_PORT;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string;
    if (argument !== "--port") throw new Error(`unknown flag: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("--port requires a value");
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`--port must be an integer between 1 and 65535 (got ${value})`);
    }
    port = parsed;
    index++;
  }
  return { port };
}

/**
 * The console is served from the checkout, never bundled: both src/index.ts
 * and dist/index.js sit one directory under apps/daemon, so ../../web from
 * the entry's directory names apps/web either way.
 */
export function resolveWebDir(entry: string | undefined): string {
  return resolve(dirname(entry ?? "src/index.ts"), "../../web");
}

function exitOf(child: ChildProcess): Promise<number> {
  return new Promise((done, fail) => {
    child.once("error", fail);
    // "exit", not "close": stdio is inherited, so there are no pipes to drain.
    child.once("exit", (code, signal) => done(code ?? (signal !== null ? 1 : 0)));
  });
}

export async function runUi(args: readonly string[]): Promise<void> {
  const { port } = parseUiArguments(args);
  const webDir = resolveWebDir(process.argv[1]);
  if (!existsSync(join(webDir, "package.json"))) {
    throw new Error(
      `no web console app at ${webDir} — score ui serves apps/web from the score checkout and cannot serve the console from a CLI installed outside it`,
    );
  }
  const env = {
    ...process.env,
    // The resolved absolute home, never the raw env value: the console runs
    // with cwd=webDir, where a relative SCORE_HOME would name another dir.
    ...(process.env.SCORE_HOME !== undefined && { SCORE_HOME: scoreHome() }),
  };
  // BUILD_ID, not .next itself: a failed or interrupted build leaves a
  // partial .next (cache, no BUILD_ID) that `next start` refuses, and gating
  // on the directory would skip the rebuild forever — BUILD_ID is written
  // only when a build completes.
  if (!existsSync(join(webDir, ".next", "BUILD_ID"))) {
    console.log("no console build found — building first (one-time)");
    const code = await exitOf(
      spawn("bun", ["run", "build"], { cwd: webDir, stdio: "inherit", env }),
    );
    if (code !== 0) {
      throw new Error(
        `console build failed (exit ${code}) — fix the build in ${webDir} and re-run: score ui`,
      );
    }
  }
  const child = spawn("bun", ["run", "start", "--", "--port", String(port)], {
    cwd: webDir,
    stdio: "inherit",
    env,
  });
  // Forwarded, not just inherited: a kill aimed at this pid alone (a plain
  // `kill`, a supervisor) must still reach the server child, not orphan it.
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  console.log(`console: http://127.0.0.1:${port}`);
  try {
    process.exitCode = await exitOf(child);
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}
