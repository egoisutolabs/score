import { homedir } from "node:os";
import { join } from "node:path";

import { BunCommandRunner, LoggingCommandRunner } from "@/adapters/command-runner";
import { GitService } from "@/adapters/git";
import { GitHubService } from "@/adapters/github";
import { TmuxService } from "@/adapters/tmux";
import { CleanupService } from "@/features/cleanup/service";
import { PassCachedChangeHost } from "@/features/daemon/observations";
import { RepairLedger } from "@/features/daemon/repair-ledger";
import type { DaemonPhase } from "@/features/daemon/service";
import { DaemonService } from "@/features/daemon/service";
import { DispatchService } from "@/features/dispatch/service";
import { TaskBriefingService } from "@/features/dispatch/task-briefing";
import { renderLandingTick } from "@/features/landing/render";
import { LandingService } from "@/features/landing/service";
import { renderMaintenanceTick } from "@/features/maintenance/render";
import { LegacyWorkflowService } from "@/features/maintenance/service";
import { DEFAULT_SESSION_SUFFIX } from "@/features/repair/policy";
import { renderRepairRun } from "@/features/repair/run";
import { RepairService } from "@/features/repair/service";
import {
  discoverLegacyRuntime,
  positiveEnvironment,
  runPollingLoop,
} from "@/shared/legacy-runtime";
import { createLogger } from "@/shared/log";

const KNOWN_FLAGS = ["--once", "--dry-run", "--verbose", "--no-merge"] as const;

export interface DaemonArguments {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly noMerge: boolean;
}

export function parseDaemonArguments(args: readonly string[]): DaemonArguments {
  for (const argument of args) {
    if (!KNOWN_FLAGS.includes(argument as (typeof KNOWN_FLAGS)[number])) {
      throw new Error(`unknown flag: ${argument}`);
    }
  }
  const flags = new Set(args);
  return {
    once: flags.has("--once"),
    dryRun: flags.has("--dry-run"),
    verbose: flags.has("--verbose"),
    noMerge: flags.has("--no-merge"),
  };
}

/**
 * One process, one tick clock: cleanup+dispatch every tick, landing every
 * second tick, repair every tick. Phases share one set of adapters and run
 * strictly in order, which keeps the primary checkout single-writer.
 */
export async function runDaemon(args: readonly string[]): Promise<void> {
  const parsed = parseDaemonArguments(args);
  const { dryRun, noMerge } = parsed;
  const log = createLogger(parsed.verbose);
  const runner = new LoggingCommandRunner(new BunCommandRunner(), log);
  const runtime = await discoverLegacyRuntime(runner, {
    requireGhAuth: true,
    requireTmux: true,
  });
  const workspaceRoot = join(
    process.env.WORKTREE_ROOT || join(homedir(), "wt"),
    runtime.repositoryName,
  );
  const tickIntervalMs = positiveEnvironment("TICK_INTERVAL_MS", 60_000);
  const maxParallelIssues = positiveEnvironment("MAX_PARALLEL", 1);
  const maxMerges = positiveEnvironment("MAX_MERGES", 5);
  const soakTicks = positiveEnvironment("SOAK_TICKS", 2);
  const skipLabels = (process.env.SKIP_LABELS || "hold,wip,do-not-merge")
    .split(",")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);

  log.info(
    `daemon ${runtime.repository} | tick ${Math.round(tickIntervalMs / 1_000)}s | max ${maxParallelIssues} | max-merges ${maxMerges} | soak ${soakTicks} ticks${dryRun ? " | dry-run" : ""}${noMerge ? " | no-merge" : ""}`,
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
  const tmux = new TmuxService(runner, { repositoryPath: runtime.repositoryRoot, dryRun });
  const observations = new PassCachedChangeHost(github);

  const maintenance = new LegacyWorkflowService(
    new CleanupService(
      {
        defaultBranch: runtime.defaultBranch,
        workspaceRoot,
        harnessOwnedPaths: ["TASK.md", ".claude/"],
        autoPullMain: process.env.AUTO_PULL_MAIN !== "0",
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
          eligibleLabelPrefix: process.env.EPIC_LABEL_PREFIX || "epic:",
          holdLabel: "hold",
          umbrellaLabel: "umbrella",
        },
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
      onlyIssueBranches: process.env.ONLY_ISSUE_BRANCHES === "1",
    },
    github,
    git,
    runner,
  );
  const ledger = new RepairLedger(positiveEnvironment("REPAIR_STALE_TICKS", 10));
  const repair = new RepairService(
    {
      agentCommand: process.env.AGENT_CMD || "claude",
      verificationCommands: process.env.VERIFY_CMDS || "cd daemon && bun run check && bun test",
      sessionSuffix: process.env.SESSION_SUFFIX || DEFAULT_SESSION_SUFFIX,
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

  const daemon = new DaemonService(phases, (name, error) => {
    log.warn(`✗ phase ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) log.debug(error.stack);
  });

  await runPollingLoop(
    async () => {
      currentTick = daemon.tick;
      const startedAt = Date.now();
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
    },
    parsed.once,
    tickIntervalMs,
  );
}
