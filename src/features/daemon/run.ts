import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { BunCommandRunner, LoggingCommandRunner, requireSuccess } from "@/adapters/command-runner";
import { GitService } from "@/adapters/git";
import { GitHubService } from "@/adapters/github";
import { TmuxService } from "@/adapters/tmux";
import { CleanupService } from "@/features/cleanup/service";
import { logsDir, promptsDir, statusPath } from "@/features/config/layout";
import type { AgentConfig, ResolvedProject } from "@/features/config/model";
import { readResolvedProject } from "@/features/config/resolved";
import { PassCachedChangeHost } from "@/features/daemon/observations";
import { RepairLedger } from "@/features/daemon/repair-ledger";
import type { DaemonPhase } from "@/features/daemon/service";
import { DaemonService } from "@/features/daemon/service";
import { gateFailureFrom, StatusWriter } from "@/features/daemon/status";
import { DispatchService } from "@/features/dispatch/service";
import { TaskBriefingService } from "@/features/dispatch/task-briefing";
import { renderLandingTick } from "@/features/landing/render";
import { LandingService } from "@/features/landing/service";
import { renderMaintenanceTick } from "@/features/maintenance/render";
import { LegacyWorkflowService } from "@/features/maintenance/service";
import { sessionSuffixForNamespace } from "@/features/repair/policy";
import { renderRepairRun } from "@/features/repair/run";
import { RepairService } from "@/features/repair/service";
import { agentConfigFromCommand } from "@/shared/agent-command";
import type { CommandRunner } from "@/shared/command-runner";
import type { FileLogger } from "@/shared/file-log";
import { createFileLogger } from "@/shared/file-log";
import type { LegacyRuntimeContext } from "@/shared/legacy-runtime";
import {
  discoverLegacyRuntime,
  positiveEnvironment,
  runPollingLoop,
} from "@/shared/legacy-runtime";
import type { Logger } from "@/shared/log";
import { createLogger } from "@/shared/log";

const KNOWN_FLAGS = ["--once", "--dry-run", "--verbose", "--no-merge", "--managed"] as const;
const VALUE_FLAGS = ["--project", "--config"] as const;

export interface DaemonArguments {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly noMerge: boolean;
  readonly managed: boolean;
  /** Managed mode: run against this configured project instead of discovery. */
  readonly project?: string;
  /** Test override for the resolved.json path; defaults to the layout path. */
  readonly resolvedPath?: string;
}

export function parseDaemonArguments(args: readonly string[]): DaemonArguments {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] as string;
    if ((VALUE_FLAGS as readonly string[]).includes(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      values.set(argument, value);
      index++;
      continue;
    }
    if (!KNOWN_FLAGS.includes(argument as (typeof KNOWN_FLAGS)[number])) {
      throw new Error(`unknown flag: ${argument}`);
    }
    flags.add(argument);
  }
  const project = values.get("--project");
  if (project === undefined && flags.has("--managed")) {
    throw new Error("--managed requires --project");
  }
  if (project === undefined && values.has("--config")) {
    throw new Error("--config requires --project");
  }
  const resolvedPath = values.get("--config");
  return {
    once: flags.has("--once"),
    dryRun: flags.has("--dry-run"),
    verbose: flags.has("--verbose"),
    noMerge: flags.has("--no-merge"),
    managed: flags.has("--managed"),
    ...(project !== undefined && { project }),
    ...(resolvedPath !== undefined && { resolvedPath }),
  };
}

export interface DaemonBootstrap {
  readonly runtime: LegacyRuntimeContext;
  readonly workspaceRoot: string;
  readonly tickIntervalMs: number;
  readonly maxParallelIssues: number;
  readonly noMerge: boolean;
  readonly managed: boolean;
  readonly agent: AgentConfig;
  /** Managed mode: the project key namespacing sessions and prompt files. */
  readonly namespace?: string;
  readonly promptsDir?: string;
  /** Managed mode: dated log files older than this are swept. */
  readonly logRetentionDays?: number;
}

/**
 * Managed mode reads only resolved.json: repository root, GitHub repo, and
 * worktree root come from config, and env tuning is ignored so a stray shell
 * export cannot skew a supervised daemon. Unmanaged keeps discovery unchanged.
 */
export async function bootstrapDaemon(
  parsed: DaemonArguments,
  runner: CommandRunner,
): Promise<DaemonBootstrap> {
  if (parsed.project === undefined) {
    const runtime = await discoverLegacyRuntime(runner, {
      requireGhAuth: true,
      requireTmux: true,
    });
    return {
      runtime,
      workspaceRoot: join(
        process.env.WORKTREE_ROOT || join(homedir(), "wt"),
        runtime.repositoryName,
      ),
      tickIntervalMs: positiveEnvironment("TICK_INTERVAL_MS", 60_000),
      maxParallelIssues: positiveEnvironment("MAX_PARALLEL", 1),
      noMerge: parsed.noMerge,
      managed: false,
      agent: agentConfigFromCommand(process.env.AGENT_CMD),
    };
  }
  const project = await readResolvedProject(parsed.project, parsed.resolvedPath);
  // GH_REPO redirects every cwd-scoped gh call away from the checkout's
  // origin; a supervised daemon must only act on the verified checkout.
  delete process.env.GH_REPO;
  const runtime = await preflightManagedRuntime(runner, project, parsed.dryRun);
  return {
    runtime,
    // worktree_location IS the worktree directory — never append the repo
    // name; that nesting made legacy autopilot see 0 worktrees and re-dispatch.
    workspaceRoot: project.worktreeLocation,
    tickIntervalMs: project.tickIntervalMs,
    maxParallelIssues: project.maxParallel,
    noMerge: parsed.noMerge || !project.autoMerge,
    managed: true,
    agent: project.agent,
    namespace: project.key,
    promptsDir: promptsDir(project.key),
    logRetentionDays: project.logRetentionDays,
  };
}

/**
 * owner/repo from a remote URL, but only when github.com is the actual HOST,
 * anchored per canonical form — substring scans accepted mirrors carrying
 * "github.com" as a path segment (gitlab.com/github.com/owner/repo).
 */
function githubRepoFromRemoteUrl(url: string): string | undefined {
  const stripped = url.replace(/\.git$/, "");
  // scp-like: [user@]github.com:owner/repo
  const scp = stripped.match(/^(?:[^@/]+@)?github\.com:([^/]+\/[^/]+)$/);
  if (scp) return scp[1];
  // URL forms: https|ssh|git://[user@]github.com/owner/repo
  return stripped.match(/^(?:https|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([^/]+\/[^/]+)$/)?.[1];
}

/** Same preflights as discovery — gh auth, tmux — plus proof that main_location really is a git toplevel. */
async function preflightManagedRuntime(
  runner: CommandRunner,
  project: ResolvedProject,
  dryRun: boolean,
): Promise<LegacyRuntimeContext> {
  const toplevel = requireSuccess(
    await runner.run(["git", "rev-parse", "--show-toplevel"], { cwd: project.mainLocation }),
  ).stdout.trim();
  if ((await realpath(toplevel)) !== (await realpath(project.mainLocation))) {
    throw new Error(
      `projects.${project.key}.main_location ${project.mainLocation} is not a git toplevel (git reports ${toplevel})`,
    );
  }
  // github_repo is hand-editable config: prove it against the checkout's git
  // origin, not gh defaults — GH_REPO or `gh repo set-default` can make gh
  // report the configured repo even when the checkout belongs to another.
  // Check ALL fetch and push URLs: a remote can carry several, and git push
  // sends the default branch to every one of them.
  for (const [kind, args] of [
    ["origin", ["git", "remote", "get-url", "--all", "origin"]],
    ["origin push URL", ["git", "remote", "get-url", "--push", "--all", "origin"]],
  ] as const) {
    const urls = requireSuccess(await runner.run(args, { cwd: project.mainLocation }))
      .stdout.trim()
      .split("\n");
    for (const url of urls) {
      const observed = githubRepoFromRemoteUrl(url);
      if (observed?.toLowerCase() !== project.githubRepo.toLowerCase()) {
        throw new Error(
          `projects.${project.key}.github_repo ${project.githubRepo} does not match ${kind} ${url} at ${project.mainLocation} (canonical github.com URLs only)`,
        );
      }
    }
  }
  // gh repo set-default persists in the checkout's git config and redirects
  // issue/PR commands even when origin matches; refuse to run under one that
  // points anywhere but origin itself.
  const setDefault = await runner.run(
    ["git", "config", "--get-regexp", "^remote\\..*\\.gh-resolved$"],
    { cwd: project.mainLocation },
  );
  if (setDefault.exitCode === 0) {
    const foreign = setDefault.stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "remote.origin.gh-resolved base");
    if (foreign.length > 0) {
      throw new Error(
        `gh repo set-default in ${project.mainLocation} points away from origin (${foreign.join("; ")}) — run: gh repo set-default ${project.githubRepo}`,
      );
    }
  }
  requireSuccess(await runner.run(["gh", "auth", "status"], { cwd: project.mainLocation }));
  // Even with no set-default entry, gh resolves its base repo by remote sort
  // order (upstream before origin) when it cannot prompt. Prove gh's own
  // resolution lands on the configured repo, so issue/PR observation reads
  // the same repository git pushes to.
  const ghResolved = JSON.parse(
    requireSuccess(
      await runner.run(["gh", "repo", "view", "--json", "nameWithOwner"], {
        cwd: project.mainLocation,
      }),
    ).stdout,
  ).nameWithOwner as string;
  if (ghResolved.toLowerCase() !== project.githubRepo.toLowerCase()) {
    throw new Error(
      `gh resolves ${project.mainLocation} to ${ghResolved}, not projects.${project.key}.github_repo ${project.githubRepo} — run: gh repo set-default ${project.githubRepo}`,
    );
  }
  requireSuccess(await runner.run(["tmux", "-V"], { cwd: project.mainLocation }));
  // A tmux server that predates this daemon keeps the env it started with;
  // agents in new sessions would inherit a stale GH_REPO and act on the
  // wrong repo. Failure is fine — with no server running, the one our
  // sessions start later inherits this process's already-cleaned env. This
  // mutates the live server, so it honors the dry-run gate like every other
  // mutation in the codebase.
  await runner.run(["tmux", "set-environment", "-g", "-r", "GH_REPO"], {
    cwd: project.mainLocation,
    mutates: true,
    dryRun,
  });
  let defaultBranch = "main";
  const branch = await runner.run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: project.mainLocation,
  });
  if (branch.exitCode === 0) {
    defaultBranch = branch.stdout.trim().replace("refs/remotes/origin/", "");
  }
  // Cleanup's auto-pull runs `git pull --ff-only` with no remote, which pulls
  // from the branch's configured upstream — commits from a fork or mirror
  // would then be pushed back to origin by landing. Require origin's own
  // branch as the upstream.
  const upstream = await runner.run(
    ["git", "rev-parse", "--abbrev-ref", `${defaultBranch}@{upstream}`],
    { cwd: project.mainLocation },
  );
  const expectedUpstream = `origin/${defaultBranch}`;
  const observedUpstream = upstream.exitCode === 0 ? upstream.stdout.trim() : "no upstream";
  if (observedUpstream !== expectedUpstream) {
    throw new Error(
      `default branch ${defaultBranch} in ${project.mainLocation} must track ${expectedUpstream} (found ${observedUpstream}) — run: git branch --set-upstream-to=${expectedUpstream} ${defaultBranch}`,
    );
  }
  return {
    repositoryRoot: project.mainLocation,
    repository: project.githubRepo,
    repositoryName: basename(project.mainLocation),
    defaultBranch,
  };
}

/**
 * A SIGKILL mid-landing leaves MERGE_HEAD in the primary checkout, wedging
 * every later landing tick. The managed daemon owns that checkout's merges
 * (epic decision 9), so startup may safely abort a leftover one — before any
 * phase runs, so landing's own staging/abort logic is untouched. Fail-closed:
 * if the abort does not clear MERGE_HEAD, throw so the supervisor restarts
 * with the repository untouched beyond git's own state.
 */
export async function selfHealStagedMerge(
  git: Pick<GitService, "mergeInProgress" | "abortMerge">,
  log: Logger,
  dryRun: boolean,
): Promise<void> {
  if (!(await git.mergeInProgress())) return;
  if (dryRun) {
    log.warn("staged merge left by a previous run (MERGE_HEAD present); would abort");
    return;
  }
  await git.abortMerge();
  if (await git.mergeInProgress()) {
    throw new Error("failed to abort the staged merge left by a previous run");
  }
  log.warn("recovered staged merge left by a previous run");
}

interface ManagedRuntime {
  readonly fileLog: FileLogger;
  readonly status: StatusWriter;
}

export async function runDaemon(args: readonly string[]): Promise<void> {
  const parsed = parseDaemonArguments(args);
  if (!parsed.managed) {
    await runDaemonLoop(parsed, createLogger(parsed.verbose));
    return;
  }
  // --managed is the supervised runtime: dated file logs with retention and
  // an atomic status.json heartbeat. Parse enforces --managed ⇒ --project.
  const project = parsed.project as string;
  const fileLog = createFileLogger(logsDir(project), parsed.verbose);
  const status = new StatusWriter(statusPath(project));
  try {
    await runDaemonLoop(parsed, fileLog, { fileLog, status });
  } catch (error) {
    // Fatal errors reach the dated file too; index.ts still prints to stderr,
    // which launchd redirects to the crash log.
    const message = error instanceof Error ? error.message : String(error);
    fileLog.warn(`fatal: ${message}`);
    await status.write({ last_error: message }).catch(() => {});
    throw error;
  } finally {
    await status.settle().catch(() => {});
  }
}

/**
 * One process, one tick clock: cleanup+dispatch every tick, landing every
 * second tick, repair every tick. Phases share one set of adapters and run
 * strictly in order, which keeps the primary checkout single-writer.
 */
async function runDaemonLoop(
  parsed: DaemonArguments,
  log: Logger,
  managedRuntime?: ManagedRuntime,
): Promise<void> {
  const { dryRun } = parsed;
  const status = managedRuntime?.status;
  const runner = new LoggingCommandRunner(new BunCommandRunner(), log);
  const {
    runtime,
    workspaceRoot,
    tickIntervalMs,
    maxParallelIssues,
    noMerge,
    managed,
    agent,
    namespace,
    promptsDir: projectPromptsDir,
    logRetentionDays,
  } = await bootstrapDaemon(parsed, runner);
  if (managedRuntime && logRetentionDays !== undefined) {
    managedRuntime.fileLog.enableRetention(logRetentionDays);
  }
  await status?.write({ state: "starting" });
  // Managed daemons read tuning from resolved.json only; the rest of the env
  // knobs fall back to their built-in defaults instead of the shell.
  const tuning = (name: string): string | undefined => (managed ? undefined : process.env[name]);
  const positiveTuning = (name: string, fallback: number): number =>
    managed ? fallback : positiveEnvironment(name, fallback);
  const maxMerges = positiveTuning("MAX_MERGES", 5);
  const soakTicks = positiveTuning("SOAK_TICKS", 2);
  const skipLabels = (tuning("SKIP_LABELS") || "hold,wip,do-not-merge")
    .split(",")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);

  log.info(
    `daemon ${runtime.repository}${parsed.project ? ` | project ${parsed.project}` : ""} | tick ${Math.round(tickIntervalMs / 1_000)}s | max ${maxParallelIssues} | max-merges ${maxMerges} | soak ${soakTicks} ticks${dryRun ? " | dry-run" : ""}${noMerge ? " | no-merge" : ""}`,
  );
  log.info("phases: cleanup+dispatch every tick | landing every 2 ticks | repair every tick");
  log.debug(`repo root ${runtime.repositoryRoot} | worktrees ${workspaceRoot}`);
  log.debug(`default branch ${runtime.defaultBranch} | skip-labels ${skipLabels.join(",")}`);

  const github = new GitHubService(runner, {
    repositoryPath: runtime.repositoryRoot,
    repository: runtime.repository,
  });
  // One GitService for every phase: workspaceRoot only guards the worktree
  // mutations dispatch and cleanup make; landing and repair never call those.
  const git = new GitService(runner, {
    repositoryPath: runtime.repositoryRoot,
    workspaceRoot,
    dryRun,
  });
  const tmux = new TmuxService(runner, {
    repositoryPath: runtime.repositoryRoot,
    dryRun,
    namespace,
    promptsDir: projectPromptsDir,
  });
  const observations = new PassCachedChangeHost(github);

  if (managedRuntime) await selfHealStagedMerge(git, log, dryRun);

  const maintenance = new LegacyWorkflowService(
    new CleanupService(
      {
        defaultBranch: runtime.defaultBranch,
        workspaceRoot,
        harnessOwnedPaths: ["TASK.md", ".claude/"],
        autoPullMain: tuning("AUTO_PULL_MAIN") !== "0",
        namespace,
      },
      github,
      git,
      tmux,
    ),
    new DispatchService(
      {
        workspaceRoot,
        maxParallelIssues,
        issues: {
          eligibleLabelPrefix: tuning("EPIC_LABEL_PREFIX") || "epic:",
          holdLabel: "hold",
          umbrellaLabel: "umbrella",
        },
        agent,
        namespace,
      },
      github,
      observations,
      git,
      tmux,
      new TaskBriefingService(),
    ),
  );
  const landing = new LandingService(
    {
      repositoryRoot: runtime.repositoryRoot,
      repository: runtime.repository,
      defaultBranch: runtime.defaultBranch,
      dryRun,
      noMerge,
      maxMerges,
      soakTicks,
      skipLabels,
      onlyIssueBranches: tuning("ONLY_ISSUE_BRANCHES") === "1",
    },
    github,
    git,
    runner,
  );
  const ledger = new RepairLedger(positiveTuning("REPAIR_STALE_TICKS", 10));
  const repair = new RepairService(
    {
      agent,
      verificationCommands: tuning("VERIFY_CMDS") || "cd daemon && bun run check && bun test",
      sessionSuffix: tuning("SESSION_SUFFIX") || sessionSuffixForNamespace(namespace),
      includeClean: false,
      onlyPullRequests: new Set<string>(),
      noSpawn: false,
      shouldAct: (number, defects, headSha) => ledger.shouldAct(number, defects, headSha),
    },
    github,
    git,
    tmux,
  );

  const pass = { cleaned: 0, started: 0, merged: 0, soaking: 0, repaired: 0, working: 0 };
  let currentTick = 0;
  // Retained across passes: landing runs every second tick, and status keeps
  // carrying the last landing verdict until the next landing tick replaces it.
  let lastGateFailure: string | null = null;
  let passError: string | null = null;
  let stopping = false;
  const phases: readonly DaemonPhase[] = [
    {
      // Cleanup before dispatch is the legacy invariant: free capacity first.
      name: "cleanup+dispatch",
      everyTicks: 1,
      run: async () => {
        const result = await maintenance.runMaintenanceTick(dryRun);
        log.lines(renderMaintenanceTick(result));
        pass.cleaned += result.cleanup.filter(
          (cleanup) => cleanup.action === "CLEANED" || cleanup.action === "PLANNED",
        ).length;
        pass.started += result.dispatch.started.length + result.dispatch.planned.length;
      },
    },
    {
      name: "landing",
      everyTicks: 2,
      run: async () => {
        const results = await landing.runTick();
        lastGateFailure = gateFailureFrom(results);
        log.lines(renderLandingTick(results));
        pass.merged += results.filter(
          (result) => result.tag === "merged" || result.tag === "would-merge",
        ).length;
        pass.soaking += results.filter((result) => result.tag === "soaking").length;
      },
    },
    {
      name: "repair",
      everyTicks: 1,
      run: async () => {
        ledger.startPass(currentTick, new Set(await tmux.listSessions()));
        const results = await repair.run(dryRun);
        ledger.finishPass(results);
        const acted = results.filter(
          (result) => result.action === "PINGED" || result.action === "SPAWNED",
        ).length;
        // renderRepairRun always prints a summary line; at one tick apiece that
        // is noise, so a tick with nothing to fix stays at debug.
        if (acted > 0) log.lines(renderRepairRun(results));
        else log.debug(`repair: ${results.length} PRs scanned, none need fixing`);
        pass.repaired += acted;
        pass.working += results.filter((result) => result.action === "WORKING").length;
      },
    },
  ];

  const daemon = new DaemonService(
    phases,
    (name, error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`✗ phase ${name} failed: ${message}`);
      if (error instanceof Error && error.stack) log.debug(error.stack);
      passError = `${name}: ${message}`;
    },
    () => stopping,
  );

  await runPollingLoop(
    async () => {
      currentTick = daemon.tick;
      const startedAt = Date.now();
      passError = null;
      await status?.write({
        state: "running",
        tick: currentTick,
        last_pass_started_at: new Date().toISOString(),
      });
      observations.startPass();
      for (const key of Object.keys(pass) as (keyof typeof pass)[]) pass[key] = 0;

      await daemon.runPass();

      const elapsedMs = Date.now() - startedAt;
      const changed = pass.cleaned + pass.started + pass.merged + pass.repaired;
      log.lines([
        {
          level: changed > 0 ? "info" : "debug",
          text: `pass ${currentTick} summary: cleaned=${pass.cleaned} started=${pass.started} merged=${pass.merged} soaking=${pass.soaking} repaired=${pass.repaired} working=${pass.working} (${Math.round(elapsedMs / 1_000)}s)`,
        },
      ]);
      // Phases are sequential by design; a pass longer than the tick just
      // delays the next one. Say so instead of trying to catch up.
      if (elapsedMs > tickIntervalMs) {
        log.warn(
          `pass ${currentTick} took ${Math.round(elapsedMs / 1_000)}s, longer than the ${Math.round(tickIntervalMs / 1_000)}s tick`,
        );
      }
      await status?.write({
        last_pass_completed_at: new Date().toISOString(),
        last_error: passError,
        last_gate_failure: lastGateFailure,
      });
    },
    parsed.once,
    tickIntervalMs,
    managedRuntime
      ? {
          interruptible: true,
          onStopRequested: () => {
            stopping = true;
            void status?.write({ state: "stopping" });
          },
        }
      : {},
  );
}
