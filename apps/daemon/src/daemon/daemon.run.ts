import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { OpencodeService } from "@score/agents/opencode.service";
import type { OpencodeServerHandle } from "@score/agents/opencode-server.service";
import { OpencodeServer } from "@score/agents/opencode-server.service";
import { TmuxService } from "@score/agents/tmux.service";
import { GitService } from "@score/core/adapters/git.service";
import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { CleanupService } from "@score/core/cleanup/cleanup.service";
import type { DaemonPhase } from "@score/core/daemon/daemon.service";
import { DaemonService } from "@score/core/daemon/daemon.service";
import { PassCachedChangeHost } from "@score/core/daemon/observations.service";
import { RepairLedger } from "@score/core/daemon/repair-ledger.service";
import {
  applyGateVerdicts,
  gateFailureFrom,
  StatusWriter,
} from "@score/core/daemon/status.service";
import { DispatchService } from "@score/core/dispatch/dispatch.service";
import { TaskBriefingService } from "@score/core/dispatch/task-briefing.service";
import { meaningfulStatusLines } from "@score/core/landing/landing.policy";
import { renderLandingTick } from "@score/core/landing/landing.render";
import { LandingService } from "@score/core/landing/landing.service";
import { renderMaintenanceTick } from "@score/core/maintenance/maintenance.render";
import { LegacyWorkflowService } from "@score/core/maintenance/maintenance.service";
import { sessionSuffixForNamespace } from "@score/core/repair/repair.policy";
import { RepairService } from "@score/core/repair/repair.service";
import {
  BunCommandRunner,
  LoggingCommandRunner,
  requireSuccess,
} from "@score/shared/adapters/command-runner.service";
import { agentConfigFromCommand } from "@score/shared/agent-command";
import type { CommandRunner } from "@score/shared/command-runner.interface";
import type { AgentConfig, ResolvedProject } from "@score/shared/config/config.interface";
import { logsDir, promptsDir, statusPath } from "@score/shared/config/layout";
import { PROJECT_KEY_PATTERN } from "@score/shared/config/load";
import { readResolvedProject } from "@score/shared/config/resolved";
import type { FileLogger } from "@score/shared/file-log";
import { createFileLogger } from "@score/shared/file-log";
import type { LegacyRuntimeContext } from "@score/shared/legacy-runtime";
import {
  discoverLegacyRuntime,
  positiveEnvironment,
  runPollingLoop,
} from "@score/shared/legacy-runtime";
import type { Logger } from "@score/shared/log";
import { createLogger } from "@score/shared/log";
import { GitHubService } from "@score/tracker/github.service";
import { renderRepairRun } from "../repair/repair.run";
import { proveLandingAuthorship } from "./recovery.policy";

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
  if (project.agent.harness === "opencode") {
    // Locked decision 13 — v1 has no HTTP auth, so a passworded child can
    // never be authenticated by the adapter; refuse before it ever spawns.
    if (process.env.OPENCODE_SERVER_PASSWORD !== undefined) {
      throw new Error(
        "OPENCODE_SERVER_PASSWORD is set, but the opencode adapter has no HTTP auth support (locked decision 13) — unset it before running a managed opencode daemon",
      );
    }
    requireSuccess(await runner.run(["opencode", "--version"], { cwd: project.mainLocation }));
  } else {
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
  }
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
  // An invalid configured model does NOT die at birth — interactive claude
  // parks at the REPL as a zombie (observed live on #45), evading the tmux
  // birth check and every other runtime signal. One bounded print-mode call
  // proves the model with the CLI's own error before any dispatch. It is
  // billable, so it runs LAST (a supervisor restart-looping on some cheaper
  // local misconfiguration must never burn a model call per restart) and
  // rides the dry-run mutation gate: spending quota is not a preview.
  if (project.agent.harness !== "opencode" && project.agent.model !== undefined) {
    requireSuccess(
      await runner.run(
        ["claude", "--model", project.agent.model, "-p", "Reply with the single word: ok"],
        { cwd: project.mainLocation, mutates: true, dryRun },
      ),
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
 * with the repository untouched beyond git's own state. (A kill between
 * commitMerge and push leaves a different wedge — committed-but-unpushed
 * merge, no MERGE_HEAD; reconcileUnpushedLandingMerge below recovers that
 * one, per locked decision D1: reset and re-land.)
 */
export async function selfHealStagedMerge(
  git: Pick<GitService, "mergeInProgress" | "abortMerge" | "observePrimaryCheckout">,
  log: Logger,
  dryRun: boolean,
  defaultBranch: string,
): Promise<void> {
  if (!(await git.mergeInProgress())) return;
  // Landing only ever stages merges on the default branch, so a MERGE_HEAD
  // anywhere else is not the daemon's merge to abort — an operator's
  // in-progress conflict resolution must survive a daemon start.
  const { branch } = await git.observePrimaryCheckout();
  if (branch !== defaultBranch) {
    log.warn(
      `MERGE_HEAD present on ${branch}, not ${defaultBranch}; not landing's merge, leaving it untouched`,
    );
    return;
  }
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

export interface ReconcileUnpushedMergeOptions {
  readonly dryRun: boolean;
  readonly defaultBranch: string;
  readonly repositoryOwner: string;
}

/**
 * "clean": no wedge (heads equal, behind origin, or a merge in progress that
 * the staged-merge path owns) — landing may run. "recovered": the wedge was
 * reset away and verified — landing may run. "blocked": an unreconciled
 * commit is still ahead of origin (refused, dirty, parked checkout, or
 * dry-run) — landing MUST NOT run this pass, or it would commit a new merge
 * on top and build the local-only chain D1 forbids, then push both.
 */
export type ReconcileOutcome = "clean" | "recovered" | "blocked";

/**
 * A reset that reported success but left the wrong head: evidence of checkout
 * corruption. Must crash the daemon (supervisor restarts it with the repo
 * untouched further) — never degrade to a warning like transient git errors.
 */
export class RecoveryVerificationError extends Error {}

/**
 * D1 recovery for a merge committed but never pushed: a daemon that died — or
 * caught a pushDefaultBranch failure and lived — between commitMerge and push
 * leaves the local default branch ahead of origin with no MERGE_HEAD, and the
 * still-open PR in silent limbo. When the stray head passes the
 * landing-authorship proof and the working tree is clean, reset hard to
 * origin and let the normal landing tick re-gate, re-soak, and re-merge the
 * PR. Recovery never pushes (landing stays the only push site); anything
 * unproven is warned with the observed evidence and left untouched — the
 * operator property. Runs once per pass, not only at startup, because the
 * caught-push-failure strand happens while the daemon lives.
 */
export async function reconcileUnpushedLandingMerge(
  git: Pick<
    GitService,
    | "mergeInProgress"
    | "observeCommit"
    | "fetchOrigin"
    | "isAncestor"
    | "observePrimaryCheckout"
    | "resetBranchToCommit"
    | "treeMatchesCommit"
  >,
  log: Logger,
  options: ReconcileUnpushedMergeOptions,
): Promise<ReconcileOutcome> {
  const { dryRun, defaultBranch, repositoryOwner } = options;
  // A merge in progress is selfHealStagedMerge's territory, not a stray commit.
  if (await git.mergeInProgress()) return "clean";
  // D1: fetch before evaluating anything — startup reaches here before any
  // phase fetch, so the origin/<default> tracking ref may predate the outage;
  // comparing or resetting against a stale ref would re-land from a stale
  // base, or misread a push that actually landed as a wedge.
  await git.fetchOrigin();
  const remoteRef = `origin/${defaultBranch}`;
  const local = await git.observeCommit(defaultBranch);
  const origin = await git.observeCommit(remoteRef);
  if (local.sha === origin.sha) return "clean";
  // Behind origin is cleanup's normal auto-pull, not a wedge.
  if (await git.isAncestor(local.sha, origin.sha)) return "clean";

  const { branch, status } = await git.observePrimaryCheckout();
  if (branch !== defaultBranch) {
    log.warn(
      `local ${defaultBranch} is ahead of ${remoteRef} at ${local.sha}, but the checkout is on ${branch}; leaving it untouched`,
    );
    return "blocked";
  }
  // One kind of "dirt" is recovery's own: a daemon killed between the tree
  // sync and the ref move leaves the index/worktree already at origin's
  // exact tree with the branch still on the wedge. Completing that recovery
  // touches nothing an operator could have added (the sync no-ops), so it
  // falls through to the proof; any other dirt refuses.
  if (meaningfulStatusLines(status).length > 0 && !(await git.treeMatchesCommit(origin.sha))) {
    log.warn(
      `local ${defaultBranch} is ahead of ${remoteRef} at ${local.sha}, but the working tree is dirty; refusing recovery — a reset must never eat operator edits`,
    );
    return "blocked";
  }
  const firstParent = local.parents[0];
  const proof = proveLandingAuthorship({
    commit: local,
    firstParentReachableFromOrigin:
      firstParent !== undefined && (await git.isAncestor(firstParent, origin.sha)),
    repositoryOwner,
  });
  if (!proof.proven) {
    log.warn(
      `unpushed commit ${local.sha} on ${defaultBranch} fails the landing-authorship proof (${proof.evidence}); leaving the checkout untouched`,
    );
    return "blocked";
  }
  if (dryRun) {
    log.warn(
      `would reset ${defaultBranch} to ${origin.sha}, dropping unpushed landing merge ${local.sha}; PR #${proof.pullRequestNumber} would re-land through the normal landing tick`,
    );
    return "blocked";
  }
  // Compare-and-swap from the observed wedge head to the observed origin
  // SHA: an operator commit or edit arriving after the checks above makes
  // the observations stale, and the CAS + non-clobbering tree sync abort
  // instead of silently discarding that work the way reset --hard would.
  await git.resetBranchToCommit(defaultBranch, origin.sha, local.sha);
  // Fail closed like the staged-merge heal: prove the reset actually landed.
  const after = await git.observeCommit(defaultBranch);
  if (after.sha !== origin.sha) {
    throw new RecoveryVerificationError(
      `recovery reset left ${defaultBranch} at ${after.sha}, expected ${origin.sha}`,
    );
  }
  log.warn(
    `reset unpushed landing merge ${local.sha} away; PR #${proof.pullRequestNumber} re-lands through the normal landing tick`,
  );
  return "recovered";
}

/** The subset of OpencodeServer's own shape earlyStop needs: stop() must be
 * reachable before start() resolves, not just after. */
interface StartableOpencodeServer {
  start(): Promise<OpencodeServerHandle>;
  stop(): Promise<void>;
}

interface ManagedRuntime {
  readonly fileLog: FileLogger;
  readonly status: StatusWriter;
}

/**
 * Test-only overrides, kept independent of ManagedRuntime: production's
 * unmanaged path calls runDaemonLoop with no managedRuntime at all (see
 * runDaemon below), so a seam nested inside it could never be exercised for
 * that call shape — e.g. a bare `--project X` run with an opencode harness
 * but no `--managed`.
 */
interface DaemonLoopOverrides {
  /** Overrides the opencode server. Defaults to a real `opencode serve` child. */
  readonly createOpencodeServer?: () => StartableOpencodeServer;
  /** Overrides the command runner. Defaults to the real Bun-backed one. */
  readonly runner?: CommandRunner;
}

export async function runDaemon(args: readonly string[]): Promise<void> {
  const parsed = parseDaemonArguments(args);
  // Validate before ANY path is built from the key: logsDir/statusPath join it
  // into $SCORE_HOME/projects, and a separator-bearing key would escape that
  // root. up/down validate at config load; this is the direct-invocation route.
  if (parsed.project !== undefined && !PROJECT_KEY_PATTERN.test(parsed.project)) {
    throw new Error(
      `--project must match ${PROJECT_KEY_PATTERN} (got ${JSON.stringify(parsed.project)})`,
    );
  }
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
export async function runDaemonLoop(
  parsed: DaemonArguments,
  log: Logger,
  managedRuntime?: ManagedRuntime,
  overrides?: DaemonLoopOverrides,
): Promise<void> {
  const { dryRun } = parsed;
  const status = managedRuntime?.status;
  // Heartbeat lands before the bootstrap preflight: a stalled gh/tmux/git
  // probe must not leave the supervisor staring at a stale pid.
  await status?.write({ state: "starting" });
  const runner = overrides?.runner ?? new LoggingCommandRunner(new BunCommandRunner(), log);
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
    // Claude-trust seeding is TmuxService plumbing; seeding it for opencode
    // would make cleanup's ["TASK.md"] allowlist report every merged worktree
    // BLOCKED_DIRTY over dirt Score itself created.
    seedClaudeDirectory: agent.harness !== "opencode",
  });
  // Exactly one AgentRuntime per daemon (locked decision 3): phases never
  // branch on harness, they just share this instance. Opencode owns a single
  // `opencode serve` child; claude keeps constructing TmuxService unchanged.
  let handle: OpencodeServerHandle | undefined;
  // Captured the instant the server object exists — before start() is even
  // called — because the child is alive and running for the whole
  // spawn-to-ready window (up to startupDeadlineMs), not just after start()
  // resolves. OpencodeServer.stop() is safe and effective at any point in
  // that lifecycle (it aborts an in-flight start() and kills the child), so
  // this, not `handle?.stop()`, is what closes the window end to end.
  let stopChild: (() => Promise<void>) | undefined;
  // A signal arriving after the child spawns but before runPollingLoop
  // installs its own handlers would otherwise hit the runtime's default
  // SIGINT/SIGTERM action, which skips `finally` blocks entirely and
  // orphans the child. This narrow net closes exactly that window; it is
  // removed the moment runPollingLoop's own handlers take over below.
  //
  // Kept armed with .on(), not .once(): OpencodeServer.stop() can take
  // seconds to escalate past a SIGTERM-ignoring child to SIGKILL, and a
  // second signal arriving during that escalation must hit this handler
  // again — not the runtime's default action, which a one-shot listener
  // would fall through to and force-exit before the kill completes.
  // stopChild() and process.exit() are both idempotent, so repeat firing
  // is harmless.
  const earlyStop = () => {
    void (stopChild?.() ?? Promise.resolve()).finally(() => process.exit(1));
  };
  const agents: AgentRuntime =
    agent.harness === "opencode"
      ? await (async () => {
          process.on("SIGINT", earlyStop);
          process.on("SIGTERM", earlyStop);
          const server = (overrides?.createOpencodeServer ?? (() => new OpencodeServer()))();
          stopChild = () => server.stop();
          handle = await server.start();
          return new OpencodeService(handle.baseUrl, { namespace: namespace as string, dryRun });
        })()
      : new TmuxService(runner, {
          repositoryPath: runtime.repositoryRoot,
          dryRun,
          namespace,
          promptsDir: projectPromptsDir,
        });
  // Never reassigned past this point — captured by closures below so TS
  // (and readers) can trust it stays either a live handle or undefined.
  const opencodeHandle = handle;
  const observations = new PassCachedChangeHost(github);
  // Managed mode wants graceful SIGTERM handling; an owned opencode child
  // needs the same reactivity even outside managed mode — see the
  // runPollingLoop options below.
  const reactive = managedRuntime !== undefined || opencodeHandle !== undefined;

  // Everything from here through the polling loop must run inside this
  // try/finally: any failure — including one during composition, before the
  // loop even starts — must still stop a child that was successfully
  // started. OpencodeServer.stop() is idempotent, so a later stop from the
  // SIGTERM/unexpected-exit path never double-kills anything.
  let childError: Error | undefined;
  try {
    if (managedRuntime) await selfHealStagedMerge(git, log, dryRun, runtime.defaultBranch);

    const maintenance = new LegacyWorkflowService(
      new CleanupService(
        {
          defaultBranch: runtime.defaultBranch,
          workspaceRoot,
          // .claude/ is claude-trust preseeding (TmuxService only); opencode
          // never writes it, so treating it as disposable there would let an
          // operator's genuine .claude/ change get silently discarded.
          harnessOwnedPaths: agent.harness === "opencode" ? ["TASK.md"] : ["TASK.md", ".claude/"],
          autoPullMain: tuning("AUTO_PULL_MAIN") !== "0",
          namespace,
        },
        github,
        git,
        agents,
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
          // `agents` above is constructed to match agent.harness exactly, whichever
          // AgentRuntime that turned out to be (TmuxService or OpencodeService).
          dispatchableHarnesses: [agent.harness],
        },
        github,
        observations,
        git,
        agents,
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
    const ledger = new RepairLedger(positiveTuning("REPAIR_STALE_TICKS", 10), namespace);
    const repair = new RepairService(
      {
        agent,
        sessionSuffix: tuning("SESSION_SUFFIX") || sessionSuffixForNamespace(namespace),
        includeClean: false,
        onlyPullRequests: new Set<string>(),
        noSpawn: false,
        shouldAct: (number, defects, headSha) => ledger.shouldAct(number, defects, headSha),
        buildRed: (number) => gateVerdicts.get(number),
      },
      github,
      git,
      agents,
    );

    const pass = { cleaned: 0, started: 0, merged: 0, soaking: 0, repaired: 0, working: 0 };
    let currentTick = 0;
    // Retained across passes: landing runs every second tick, and status keeps
    // carrying the last landing verdict until the next landing tick replaces it.
    let lastGateFailure: string | null = null;
    // Landing → repair build-red handoff (epic decision 11): repair's own scan
    // sees only GitHub facts, so landing's merged-tree verdicts ride this map.
    const gateVerdicts = new Map<number, string>();
    let passError: string | null = null;
    let stopping = false;
    // Set per pass by the D1 reconciliation below. While an unreconciled
    // commit sits ahead of origin (recovery refused, or reconciliation itself
    // failed), landing must not run: it would see a clean tree, commit a new
    // merge on top, and build — or even push — the chain D1 forbids.
    let landingBlocked = false;
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
          if (landingBlocked) {
            log.warn(
              "landing suppressed this pass: an unreconciled commit is ahead of origin on the default branch",
            );
            return;
          }
          const results = await landing.runTick();
          // undefined = no gate verdict this tick; the last known failure stands.
          const gateVerdict = gateFailureFrom(results);
          if (gateVerdict !== undefined) lastGateFailure = gateVerdict;
          applyGateVerdicts(gateVerdicts, results);
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
          ledger.startPass(currentTick, new Set(await agents.listSessions()));
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

    // runPollingLoop installs its own graceful SIGINT/SIGTERM handling next;
    // the narrow early-signal net above has done its job.
    process.off("SIGINT", earlyStop);
    process.off("SIGTERM", earlyStop);

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

        // D1 reconciliation runs before the phases of every pass, not only at
        // startup (the first pass runs immediately, so this is the startup
        // check too): a caught pushDefaultBranch failure strands a committed
        // merge while the daemon lives, and landing must see the recovered
        // checkout, never stage on top of the wedge. Unconditional, not
        // managed-only: every mode that runs this loop lands merges on this
        // checkout, so every mode owns the recovery of its own wedge.
        // Transient git failures (a fetch blip, say) degrade to a warning
        // like any phase error — but they also block landing this pass, and
        // only failed post-reset verification may crash the daemon.
        try {
          landingBlocked =
            (await reconcileUnpushedLandingMerge(git, log, {
              dryRun,
              defaultBranch: runtime.defaultBranch,
              repositoryOwner: runtime.repository.split("/")[0] as string,
            })) === "blocked";
        } catch (error) {
          if (error instanceof RecoveryVerificationError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`✗ reconciliation failed: ${message}`);
          passError = `reconcile: ${message}`;
          landingBlocked = true;
        }

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
      {
        // Managed mode wants graceful SIGTERM handling; an owned opencode
        // child needs the same reactivity even outside managed mode (a bare
        // `--project X` run without --managed still owns the child it just
        // spawned and must notice it dying, not just poll a dead adapter).
        ...(reactive && {
          interruptible: true,
          onStopRequested: () => {
            stopping = true;
            // Fire-and-forget from a signal handler: a failed write must not
            // become an unhandled rejection that crashes the clean shutdown.
            void status?.write({ state: "stopping" }).catch(() => {});
          },
        }),
        // The child-exit seam: reuses the identical stop machinery a signal
        // uses (same idle-sleep wake), so an unexpected exit settles the
        // pass the same way SIGTERM does.
        ...(opencodeHandle !== undefined && {
          onReady: (requestStop: () => void) => {
            opencodeHandle.unexpectedExit.then(() => {
              // A stop already under way (e.g. a supervisor's SIGTERM
              // reaching the whole cgroup, including this child, before our
              // own deferred handle.stop() runs) means this exit is
              // expected, not fatal — don't record a spurious child error.
              if (!stopping) childError = new Error("opencode child exited unexpectedly");
              stopping = true;
              requestStop();
            });
          },
        }),
      },
    );
  } finally {
    // Idempotent no-ops if runPollingLoop already took the handoff above.
    process.off("SIGINT", earlyStop);
    process.off("SIGTERM", earlyStop);
    // By now runPollingLoop's own graceful handlers have already run their
    // course (a normal shutdown) and removed themselves — nothing is
    // listening for the duration of this call. Re-arm earlyStop just around
    // it: stop() can itself take seconds to escalate past a SIGTERM-ignoring
    // child to SIGKILL, and a signal arriving during that window must still
    // reach it rather than hit the runtime default and orphan the child.
    if (opencodeHandle !== undefined) {
      process.on("SIGINT", earlyStop);
      process.on("SIGTERM", earlyStop);
    }
    await opencodeHandle?.stop();
    process.off("SIGINT", earlyStop);
    process.off("SIGTERM", earlyStop);
  }
  if (childError) throw childError;
}
