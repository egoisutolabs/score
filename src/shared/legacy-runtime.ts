import { basename } from "node:path";

import { requireSuccess } from "@/adapters/command-runner";
import type { CommandRunner } from "@/shared/command-runner";

export interface LegacyRuntimeContext {
  readonly repositoryRoot: string;
  readonly repository: string;
  readonly repositoryName: string;
  readonly defaultBranch: string;
}

export interface LegacyPreflight {
  readonly requireGhAuth: boolean;
  readonly requireTmux: boolean;
}

export async function discoverLegacyRuntime(
  runner: CommandRunner,
  preflight: LegacyPreflight,
): Promise<LegacyRuntimeContext> {
  // git already walks up to the enclosing repository, so ask it from wherever
  // this code lives (score/src/shared, or score/dist when bundled). Guessing a
  // fixed number of "../" broke the moment score became its own repository.
  const repositoryRoot = requireSuccess(
    await runner.run(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir }),
  ).stdout.trim();
  if (preflight.requireGhAuth) {
    requireSuccess(await runner.run(["gh", "auth", "status"], { cwd: repositoryRoot }));
  }
  if (preflight.requireTmux) {
    requireSuccess(await runner.run(["tmux", "-V"], { cwd: repositoryRoot }));
  }

  const repository =
    process.env.GH_REPO ||
    JSON.parse(
      requireSuccess(
        await runner.run(["gh", "repo", "view", "--json", "nameWithOwner"], {
          cwd: repositoryRoot,
        }),
      ).stdout,
    ).nameWithOwner;
  let defaultBranch = "main";
  const branch = await runner.run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: repositoryRoot,
  });
  if (branch.exitCode === 0) {
    defaultBranch = branch.stdout.trim().replace("refs/remotes/origin/", "");
  }
  return {
    repositoryRoot,
    repository,
    repositoryName: basename(repositoryRoot),
    defaultBranch,
  };
}

export function positiveEnvironment(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Legacy signal behavior finishes the current tick and does not interrupt sleep. */
export async function runPollingLoop(
  tick: () => Promise<void>,
  once: boolean,
  pollIntervalMs: number,
): Promise<void> {
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    do {
      await tick();
      if (once || stopRequested) break;
      await Bun.sleep(pollIntervalMs);
    } while (!stopRequested);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
