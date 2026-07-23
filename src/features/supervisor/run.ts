import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BunCommandRunner } from "@/adapters/command-runner";
import { projectDir, resolvedPath } from "@/features/config/layout";
import { loadConfig } from "@/features/config/load";
import type { ResolvedProject } from "@/features/config/model";
import { resolveProjects } from "@/features/config/resolve";
import { readResolvedProject } from "@/features/config/resolved";
import type { SupervisorAdapter } from "@/features/supervisor/adapter";
import { LaunchdSupervisor } from "@/features/supervisor/launchd";
import { jobLabel, renderPlist } from "@/features/supervisor/plist";
import { plan } from "@/features/supervisor/reconcile";

/** Issue 2's managed contract: absolute bun, absolute entry script, argv. */
function managedInvocation(key: string): readonly string[] {
  return [
    process.execPath,
    resolve(process.argv[1] ?? "src/index.ts"),
    "daemon",
    "--project",
    key,
    "--managed",
  ];
}

function defaultAdapter(): SupervisorAdapter {
  return new LaunchdSupervisor(new BunCommandRunner());
}

/**
 * launchd spawns jobs with a bare PATH where gh/git/tmux don't resolve, so the
 * daemon inherits this process's PATH — and SCORE_HOME, when set, so it reads
 * the same resolved.json `up` wrote.
 */
function jobEnvironment(): Record<string, string> {
  return {
    ...(process.env.PATH !== undefined && { PATH: process.env.PATH }),
    ...(process.env.SCORE_HOME !== undefined && { SCORE_HOME: process.env.SCORE_HOME }),
  };
}

function parseSingleKey(args: readonly string[], command: string): string | undefined {
  const key = args[0];
  if (key === undefined) return undefined;
  if (args.length > 1 || key.startsWith("--")) throw new Error(`usage: score ${command} [key]`);
  return key;
}

/** The daemon's only input (epic decision 3), written atomically: tmp + rename. */
async function writeResolvedJson(project: ResolvedProject): Promise<void> {
  const dir = projectDir(project.key);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, "resolved.json.tmp");
  await writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await rename(tmp, resolvedPath(project.key));
}

export interface UpDependencies {
  readonly adapter: SupervisorAdapter;
  readonly invocationFor: (key: string) => readonly string[];
}

export async function runUp(args: readonly string[], deps?: UpDependencies): Promise<void> {
  const only = parseSingleKey(args, "up");
  const adapter = deps?.adapter ?? defaultAdapter();
  const invocationFor = deps?.invocationFor ?? managedInvocation;

  // Invalid config fails closed here — no launchctl call has happened yet.
  const config = await loadConfig();
  let desired = resolveProjects(config);
  if (only !== undefined) {
    desired = desired.filter((project) => project.key === only);
    if (desired.length === 0) throw new Error(`no enabled project '${only}' in config`);
  }

  const actual = await adapter.status();
  const existing = new Map<string, ResolvedProject>();
  for (const job of actual) {
    try {
      existing.set(job.key, await readResolvedProject(job.key));
    } catch {
      // Missing or corrupt resolved.json: hash unknown, so a loaded job restarts.
    }
  }

  const decided = plan(desired, actual, existing);
  // Single-project up must not report every other supervised job as removed.
  const removed = only === undefined ? decided.removed : [];

  for (const { project, blockingKey } of decided.refused) {
    console.error(
      `refusing to start '${project.key}': ${jobLabel(blockingKey)} already supervises ${project.mainLocation} — run: score down ${blockingKey}`,
    );
    process.exitCode = 1;
  }
  for (const key of removed) {
    console.log(`'${key}' is not in config; left alone — run: score down ${key}`);
  }

  let started = 0;
  let restarted = 0;
  const apply = async (project: ResolvedProject, restart: boolean): Promise<void> => {
    try {
      if (restart) await adapter.stop(project.key);
      await writeResolvedJson(project);
      await adapter.install(
        project.key,
        renderPlist(project, invocationFor(project.key), jobEnvironment()),
      );
      await adapter.start(project.key);
      if (restart) restarted++;
      else started++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to ${restart ? "restart" : "start"} '${project.key}': ${message}`);
      process.exitCode = 1;
    }
  };
  for (const project of decided.restart) await apply(project, true);
  for (const project of decided.start) await apply(project, false);

  console.log(
    `started=${started} restarted=${restarted} unchanged=${decided.unchanged.length} removed=${removed.length}`,
  );
}

export async function runDown(
  args: readonly string[],
  adapter: SupervisorAdapter = defaultAdapter(),
): Promise<void> {
  const only = parseSingleKey(args, "down");
  const keys = only !== undefined ? [only] : (await adapter.status()).map((job) => job.key);
  for (const key of keys) {
    await adapter.uninstall(key);
    console.log(`stopped '${key}'`);
  }
  if (keys.length === 0) console.log("no score jobs");
}
