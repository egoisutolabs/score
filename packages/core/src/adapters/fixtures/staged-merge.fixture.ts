// Fixture for the staged-merge residue sweep tests (#92): a real repository
// whose feature branch introduces apps/web with its own .gitignore — the
// shape of PR #68, whose gate build outputs survived `merge --abort` in the
// primary checkout and silently wedged landing and auto-pull.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "@score/core/adapters/git.service";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";

/**
 * Real subprocess runner for fixture-repo tests. apps/daemon's wedge fixture
 * carries its own copy — core cannot import from an app, so the duplication
 * is the dependency direction's price.
 */
export class ExecRunner implements CommandRunner {
  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    try {
      const stdout = execFileSync(command[0] as string, command.slice(1), {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.env && { env: { ...process.env, ...options.env } }),
      });
      return {
        command,
        cwd: options.cwd,
        exitCode: 0,
        stdout,
        stderr: "",
        timedOut: false,
        dryRun: false,
      };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return {
        command,
        cwd: options.cwd,
        exitCode: failure.status ?? 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        timedOut: false,
        dryRun: false,
      };
    }
  }
}

export interface StagedMergeFixture {
  readonly repo: string;
  readonly git: GitService;
  /** Head of the branch that introduces apps/web/.gitignore (ignoring /.next/). */
  readonly webBranchSha: string;
  readonly gitCli: (...args: string[]) => string;
}

/** One commit on main; branch web-app adds apps/web/.gitignore that main lacks. */
export async function stagedMergeFixture(): Promise<StagedMergeFixture> {
  const repo = await mkdtemp(join(tmpdir(), "score-stage-residue-"));
  const gitCli = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  gitCli("init", "--initial-branch=main");
  gitCli("config", "user.email", "score@test.invalid");
  gitCli("config", "user.name", "score");
  gitCli("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "README.md"), "fixture\n");
  gitCli("add", "README.md");
  gitCli("commit", "-m", "initial");
  gitCli("checkout", "-b", "web-app");
  await mkdir(join(repo, "apps", "web"), { recursive: true });
  await writeFile(join(repo, "apps", "web", ".gitignore"), "/.next/\n");
  gitCli("add", "apps/web/.gitignore");
  gitCli("commit", "-m", "scaffold web app");
  const webBranchSha = gitCli("rev-parse", "HEAD");
  gitCli("checkout", "main");
  const git = new GitService(new ExecRunner(), {
    repositoryPath: repo,
    workspaceRoot: join(repo, "wt"),
  });
  return { repo, git, webBranchSha, gitCli };
}
