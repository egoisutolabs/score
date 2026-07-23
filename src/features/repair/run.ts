import { BunCommandRunner, LoggingCommandRunner } from "@/adapters/command-runner";
import { GitService } from "@/adapters/git";
import { GitHubService } from "@/adapters/github";
import { TmuxService } from "@/adapters/tmux";
import { DEFAULT_SESSION_SUFFIX } from "@/features/repair/policy";
import type { RepairResult } from "@/features/repair/result";
import { RepairService } from "@/features/repair/service";
import { discoverLegacyRuntime } from "@/shared/legacy-runtime";
import type { LogLine } from "@/shared/log";
import { createLogger } from "@/shared/log";

/** Legacy shepherd-prs output: per-PR action lines, summary counts, attach hint. */
export function renderRepairRun(results: readonly RepairResult[]): readonly LogLine[] {
  const lines: LogLine[] = [];
  const counts = { PINGED: 0, SPAWNED: 0, SKIPPED: 0, NOT_NEEDED: 0, WORKING: 0 };
  for (const result of results) {
    counts[result.action] += 1;
    const dryRun = result.dryRun ? "(dry-run) " : "";
    if (result.action === "PINGED") {
      lines.push({
        level: "info",
        text: `· #${result.pullRequestNumber} -> ${dryRun}pinged live session ${result.target}`,
      });
    } else if (result.action === "SPAWNED") {
      lines.push({
        level: "info",
        text: `· #${result.pullRequestNumber} -> ${dryRun}spawned fresh agent in ${result.target} (tmux: shepherd-pr-${result.pullRequestNumber})`,
      });
    } else if (result.action === "WORKING") {
      lines.push({
        level: "debug",
        text: `· #${result.pullRequestNumber} -> agent still working; left alone`,
      });
    } else if (result.action === "SKIPPED") {
      lines.push({
        level: "debug",
        text: `· #${result.pullRequestNumber} -> skipped (no live session, no worktree)`,
      });
    } else {
      lines.push({ level: "debug", text: `#${result.pullRequestNumber} clean; skip` });
    }
  }
  lines.push({
    level: "info",
    text: `summary: pinged=${counts.PINGED} spawned=${counts.SPAWNED} working=${counts.WORKING} skipped=${counts.SKIPPED} clean-skipped=${counts.NOT_NEEDED}`,
  });
  if (counts.SPAWNED > 0) {
    lines.push({
      level: "info",
      text: "attach a spawned agent with: tmux attach -t shepherd-pr-<PR-number>",
    });
  }
  return lines;
}

export async function runRepair(args: readonly string[]): Promise<void> {
  const parsed = parseRepairArguments(args);
  if (parsed.help) {
    console.log("repair [--dry-run] [--include-clean] [--only N,N,...] [--no-spawn] [--verbose]");
    return;
  }
  const log = createLogger(parsed.verbose);
  const runner = new LoggingCommandRunner(new BunCommandRunner(), log);
  const runtime = await discoverLegacyRuntime(runner, {
    requireGhAuth: false,
    requireTmux: false,
  });
  log.info(`repo: ${runtime.repository}${parsed.dryRun ? "  (dry-run)" : ""}`);
  const github = new GitHubService(runner, {
    repositoryPath: runtime.repositoryRoot,
    repository: runtime.repository,
  });
  const git = new GitService(runner, {
    repositoryPath: runtime.repositoryRoot,
    workspaceRoot: "/",
  });
  const tmux = new TmuxService(runner, { repositoryPath: runtime.repositoryRoot });
  const service = new RepairService(
    {
      agentCommand: process.env.AGENT_CMD || "claude",
      verificationCommands: process.env.VERIFY_CMDS || "cd daemon && bun run check && bun test",
      sessionSuffix: process.env.SESSION_SUFFIX || DEFAULT_SESSION_SUFFIX,
      includeClean: parsed.includeClean,
      onlyPullRequests: parsed.only,
      noSpawn: parsed.noSpawn,
    },
    github,
    git,
    tmux,
  );
  const results = await service.run(parsed.dryRun);
  log.lines(renderRepairRun(results));
  if (parsed.dryRun) log.info("dry run — no sessions were touched.");
  log.debug(JSON.stringify(results));
}

function parseRepairArguments(args: readonly string[]) {
  let dryRun = false;
  let includeClean = false;
  let noSpawn = false;
  let verbose = false;
  let only = "";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-h" || argument === "--help") {
      return { help: true, dryRun, includeClean, noSpawn, verbose, only: new Set<string>() };
    }
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--include-clean") includeClean = true;
    else if (argument === "--no-spawn") noSpawn = true;
    else if (argument === "--verbose") verbose = true;
    else if (argument.startsWith("--only=")) only = argument.slice("--only=".length);
    else if (argument === "--only") {
      index += 1;
      only = args[index] ?? "";
    } else throw new Error(`unknown flag: ${argument}`);
  }
  return {
    help: false,
    dryRun,
    includeClean,
    noSpawn,
    verbose,
    only: new Set(only.split(",").filter(Boolean)),
  };
}
