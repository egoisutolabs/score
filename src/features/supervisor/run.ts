import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BunCommandRunner } from "@/adapters/command-runner";
import { projectDir, resolvedPath } from "@/features/config/layout";
import { loadConfig, PROJECT_KEY_PATTERN } from "@/features/config/load";
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

/** Same-checkout claims must survive symlink spellings; unresolvable paths compare raw. */
function canonicalizer(): (path: string) => string {
  const memo = new Map<string, string>();
  return (path) => {
    let canonical = memo.get(path);
    if (canonical === undefined) {
      try {
        canonical = realpathSync(path);
      } catch {
        canonical = path;
      }
      memo.set(path, canonical);
    }
    return canonical;
  };
}

function parseSingleKey(args: readonly string[], command: string): string | undefined {
  const key = args[0];
  if (key === undefined) return undefined;
  if (args.length > 1 || key.startsWith("--")) throw new Error(`usage: score ${command} [key]`);
  // A key with separators or dots would escape the dev.score.* namespace when
  // joined into a plist path — reject before it reaches the adapter.
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new Error(`invalid project key '${key}' (must match [a-z0-9-])`);
  }
  return key;
}

/** The daemon's only input (epic decision 3), written atomically: tmp + rename. */
async function writeResolvedJson(project: ResolvedProject): Promise<void> {
  const dir = projectDir(project.key);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `resolved.json.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await rename(tmp, resolvedPath(project.key));
}

/**
 * Copy of the definition install() last wrote, kept in the state dir so a later
 * `up` can detect that an unchanged-hash job still needs a restart because the
 * rendered plist drifted (entry script moved, PATH changed).
 */
function installedDefinitionPath(key: string): string {
  return join(projectDir(key), "job.plist");
}

export interface UpDependencies {
  readonly adapter: SupervisorAdapter;
  readonly invocationFor: (key: string) => readonly string[];
}

export async function runUp(args: readonly string[], deps?: UpDependencies): Promise<void> {
  const only = parseSingleKey(args, "up");
  const adapter = deps?.adapter ?? defaultAdapter();
  const invocationFor = deps?.invocationFor ?? managedInvocation;
  const renderFor = (project: ResolvedProject): string =>
    renderPlist(project, invocationFor(project.key), jobEnvironment());

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
      // Missing or corrupt resolved.json: plan() falls back to the desired
      // config entry for the collision claim and forces a restart; with no
      // desired entry either, it fails closed and refuses new starts.
    }
  }

  const decided = plan(desired, actual, existing, canonicalizer());
  // Single-project up must not report every other supervised job as removed.
  const removed = only === undefined ? decided.removed : [];

  for (const { project, blockingKey, unknownState } of decided.refused) {
    const because = unknownState
      ? `${jobLabel(blockingKey)} is running with unreadable state, which could be this checkout`
      : `${jobLabel(blockingKey)} already supervises ${project.mainLocation}`;
    console.error(
      `refusing to start '${project.key}': ${because} — run: score down ${blockingKey}`,
    );
    process.exitCode = 1;
  }
  for (const key of removed) {
    console.log(`'${key}' is not in config; left alone — run: score down ${key}`);
  }

  // An unchanged hash still restarts when the rendered definition drifted from
  // what install() last wrote (or no record of it exists).
  const unchanged: ResolvedProject[] = [];
  const restarts = [...decided.restart];
  for (const project of decided.unchanged) {
    const installed = await readFile(installedDefinitionPath(project.key), "utf8").catch(
      () => undefined,
    );
    if (installed === renderFor(project)) unchanged.push(project);
    else restarts.push(project);
  }

  let started = 0;
  let restarted = 0;
  const apply = async (project: ResolvedProject, restart: boolean): Promise<void> => {
    try {
      const definition = renderFor(project);
      if (restart) await adapter.stop(project.key);
      await writeResolvedJson(project);
      await adapter.install(project.key, definition);
      await writeFile(installedDefinitionPath(project.key), definition, "utf8");
      await adapter.start(project.key);
      if (restart) restarted++;
      else started++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to ${restart ? "restart" : "start"} '${project.key}': ${message}`);
      process.exitCode = 1;
    }
  };
  for (const project of restarts) await apply(project, true);
  for (const project of decided.start) await apply(project, false);

  console.log(
    `started=${started} restarted=${restarted} unchanged=${unchanged.length} removed=${removed.length}`,
  );
}

export async function runDown(
  args: readonly string[],
  adapter: SupervisorAdapter = defaultAdapter(),
): Promise<void> {
  const only = parseSingleKey(args, "down");
  const keys = only !== undefined ? [only] : (await adapter.status()).map((job) => job.key);
  for (const key of keys) {
    // Per-job isolation: one failing bootout must not leave the remaining
    // jobs silently running.
    try {
      await adapter.uninstall(key);
      console.log(`stopped '${key}'`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to stop '${key}': ${message}`);
      process.exitCode = 1;
    }
  }
  if (keys.length === 0) console.log("no score jobs");
}
