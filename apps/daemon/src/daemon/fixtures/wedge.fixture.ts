// Fixtures for the D1 unpushed-merge recovery tests: a real clone plus bare
// origin wedged the way a death (or caught push failure) between commitMerge
// and pushDefaultBranch leaves it, plus the proven stray-commit evidence the
// pure proof tests perturb one check at a time.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, LANDING_COMMITTER } from "@score/core/adapters/git.service";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import type { StrayCommitEvidence } from "../daemon.run";

/** Real subprocess runner for fixture-repo tests. */
export class ExecRunner implements CommandRunner {
  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    try {
      const stdout = execFileSync(command[0] as string, command.slice(1), {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
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

/** Every check passes; tests perturb one field at a time to fail exactly one. */
export const PROVEN_STRAY: StrayCommitEvidence = {
  commit: {
    sha: "mergesha",
    parents: ["originsha", "featuresha"],
    committerName: LANDING_COMMITTER.name,
    committerEmail: LANDING_COMMITTER.email,
    message: "Merge pull request #12 from egoisutolabs/fix-the-thing\n\nFix the thing",
  },
  firstParentReachableFromOrigin: true,
  repositoryOwner: "egoisutolabs",
};

export const WEDGE_PR_NUMBER = 9;
export const WEDGE_MESSAGE = `Merge pull request #${WEDGE_PR_NUMBER} from egoisutolabs/fix-the-thing\n\nFix the thing`;
export const RECONCILE_OPTIONS = {
  dryRun: false,
  defaultBranch: "main",
  repositoryOwner: "egoisutolabs",
} as const;

export interface WedgeFixture {
  readonly repo: string;
  readonly originPath: string;
  readonly git: GitService;
  readonly gitCli: (...args: string[]) => string;
  readonly featureSha: string;
}

/**
 * A real clone plus bare origin, one commit on main pushed, and PR #9's
 * branch committed locally — the raw material for every wedge variant.
 */
export async function wedgeFixture(): Promise<WedgeFixture> {
  const root = await mkdtemp(join(tmpdir(), "score-wedge-"));
  const originPath = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", originPath], {
    stdio: "ignore",
  });
  const repo = join(root, "repo");
  execFileSync("git", ["clone", originPath, repo], { stdio: "ignore" });
  const gitCli = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  gitCli("config", "user.email", "score@test.invalid");
  gitCli("config", "user.name", "score");
  gitCli("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "README.md"), "fixture\n");
  gitCli("add", "README.md");
  gitCli("commit", "-m", "initial");
  gitCli("push", "-u", "origin", "main");
  gitCli("checkout", "-b", "fix-the-thing");
  await writeFile(join(repo, "feature.txt"), "feature\n");
  gitCli("add", "feature.txt");
  gitCli("commit", "-m", "feature");
  const featureSha = gitCli("rev-parse", "HEAD");
  gitCli("checkout", "main");
  const git = new GitService(new ExecRunner(), {
    repositoryPath: repo,
    workspaceRoot: join(repo, "wt"),
  });
  return { repo, originPath, git, gitCli, featureSha };
}

/** Commit the wedge exactly the way landing does: production staging + stamp, no push. */
export async function commitWedge(fixture: WedgeFixture): Promise<void> {
  if (!(await fixture.git.stageMerge(fixture.featureSha))) {
    throw new Error("wedge fixture: staging the feature merge failed");
  }
  await fixture.git.commitMerge(WEDGE_MESSAGE);
}
