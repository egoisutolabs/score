import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  GitService,
  LANDING_COMMITTER,
  parseWorktreePorcelain,
  stageResidue,
  statusPaths,
} from "@score/core/adapters/git.service";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import { afterEach, expect, test } from "vitest";
import { ExecRunner, stagedMergeFixture } from "./fixtures";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class ScriptRunner implements CommandRunner {
  readonly commands: string[][] = [];

  constructor(
    private readonly respond: (
      command: readonly string[],
      options: RunCommandOptions,
    ) => Promise<CommandResult> | CommandResult,
  ) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.commands.push([...command]);
    return this.respond(command, options);
  }
}

function result(
  command: readonly string[],
  options: RunCommandOptions,
  exitCode = 0,
  stdout = "",
): CommandResult {
  return {
    command,
    cwd: options.cwd,
    exitCode,
    stdout,
    stderr: "",
    timedOut: false,
    dryRun: false,
  };
}

async function sandbox(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "score-git-test-"));
  sandboxes.push(path);
  return path;
}

/** stagedMergeFixture with its repo registered for the afterEach cleanup. */
async function residueFixture() {
  const fixture = await stagedMergeFixture();
  sandboxes.push(fixture.repo);
  return fixture;
}

function identity(workspaceRoot: string): WorkIdentity {
  return {
    issueNumber: 7,
    branch: "issue-7-port-scripts",
    worktreePath: join(workspaceRoot, "issue-7-port-scripts"),
    sessionName: "issue-7",
  };
}

test("worktree parser retains branch, head, and lock observations", () => {
  const output = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /worktrees/issue-2-port
HEAD def456
branch refs/heads/issue-2-port
locked
`;
  expect(parseWorktreePorcelain(output)).toEqual([
    { path: "/repo", branch: "main", headSha: "abc123", locked: false },
    {
      path: "/worktrees/issue-2-port",
      branch: "issue-2-port",
      headSha: "def456",
      locked: true,
    },
  ]);
});

test("existing worktree directories are reused without touching git or copying files", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  await mkdir(work.worktreePath, { recursive: true });
  const runner = new ScriptRunner((command, options) => result(command, options));

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands).toEqual([]);
});

test("new branches use the local origin-HEAD branch and copy the Claude directory", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  await mkdir(join(repositoryPath, ".claude"), { recursive: true });
  await writeFile(join(repositoryPath, ".claude", "settings.json"), "legacy-settings");
  const runner = new ScriptRunner(async (command, options) => {
    const args = command.slice(1);
    if (args[0] === "symbolic-ref") {
      return result(command, options, 0, "refs/remotes/origin/main\n");
    }
    if (args[0] === "show-ref") return result(command, options, 1);
    if (args[0] === "worktree") await mkdir(work.worktreePath, { recursive: true });
    return result(command, options);
  });

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands.map((command) => command.slice(1))).toEqual([
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    ["show-ref", "--verify", "--quiet", "refs/heads/issue-7-port-scripts"],
    ["worktree", "add", "-b", work.branch, work.worktreePath, "main"],
  ]);
  expect(await readFile(join(work.worktreePath, ".claude", "settings.json"), "utf8")).toBe(
    "legacy-settings",
  );
});

test("existing issue branches are attached without creating a second branch", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  const runner = new ScriptRunner(async (command, options) => {
    const args = command.slice(1);
    if (args[0] === "symbolic-ref") {
      return result(command, options, 0, "refs/remotes/origin/main\n");
    }
    if (args[0] === "worktree") await mkdir(work.worktreePath, { recursive: true });
    return result(command, options);
  });

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands.at(-1)?.slice(1)).toEqual([
    "worktree",
    "add",
    work.worktreePath,
    work.branch,
  ]);
});

test("base resolution falls back from origin HEAD to local main and master", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  const runner = new ScriptRunner(async (command, options) => {
    const ref = command.at(-1);
    if (command[1] === "symbolic-ref") return result(command, options, 1);
    if (ref === "refs/heads/main") return result(command, options, 1);
    if (ref === "refs/heads/master") return result(command, options);
    if (command[1] === "worktree") await mkdir(work.worktreePath, { recursive: true });
    return result(command, options, ref === `refs/heads/${work.branch}` ? 1 : 0);
  });

  await new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work);

  expect(runner.commands.at(-1)?.slice(1)).toEqual([
    "worktree",
    "add",
    "-b",
    work.branch,
    work.worktreePath,
    "master",
  ]);
});

test("worktree creation fails closed when no legacy base branch can be resolved", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  const runner = new ScriptRunner((command, options) => result(command, options, 1));

  await expect(
    new GitService(runner, { repositoryPath, workspaceRoot }).createWorktree(work),
  ).rejects.toThrow("no origin/HEAD, no main, no master");
  expect(runner.commands.some((command) => command[1] === "worktree")).toBe(false);
});

test("commitMerge stamps landing's committer through the environment, beating inherited overrides", async () => {
  const captured: RunCommandOptions[] = [];
  const runner = new ScriptRunner((command, options) => {
    captured.push(options);
    return result(command, options);
  });

  await new GitService(runner, { repositoryPath: "/repo", workspaceRoot: "/wt" }).commitMerge(
    "Merge pull request #9 from owner/branch",
  );

  expect(runner.commands[0]?.slice(1)).toEqual([
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Merge pull request #9 from owner/branch",
  ]);
  // Env, not -c config: inherited GIT_COMMITTER_* variables outrank config
  // and would silently strip the stamp the recovery proof requires.
  expect(captured[0]?.env).toEqual({
    GIT_COMMITTER_NAME: LANDING_COMMITTER.name,
    GIT_COMMITTER_EMAIL: LANDING_COMMITTER.email,
  });
});

test("resetBranchToCommit syncs the tree non-destructively first, then CAS-moves the ref", async () => {
  const runner = new ScriptRunner((command, options) => result(command, options));

  await new GitService(runner, {
    repositoryPath: "/repo",
    workspaceRoot: "/wt",
  }).resetBranchToCommit("main", "originsha", "wedgesha");

  // Tree before ref: a tree-sync failure must leave the ref untouched, so
  // the branch is never left pointing where the working tree doesn't match.
  expect(runner.commands.map((command) => command.slice(1))).toEqual([
    ["read-tree", "-m", "-u", "wedgesha", "originsha"],
    [
      "update-ref",
      "-m",
      "score: D1 unpushed-merge recovery",
      "refs/heads/main",
      "originsha",
      "wedgesha",
    ],
  ]);
});

test("observeCommit parses parents, committer, and a multi-line message", async () => {
  const runner = new ScriptRunner((command, options) =>
    result(
      command,
      options,
      0,
      "abc123\ndef456 789abc\nscore-landing\nlanding@score.invalid\nMerge pull request #9 from owner/branch\n\nTitle line\n",
    ),
  );

  const commit = await new GitService(runner, {
    repositoryPath: "/repo",
    workspaceRoot: "/wt",
  }).observeCommit("main");

  expect(runner.commands[0]?.slice(1)).toEqual([
    "log",
    "-1",
    "--format=%H%n%P%n%cn%n%ce%n%B",
    "main",
  ]);
  expect(commit).toEqual({
    sha: "abc123",
    parents: ["def456", "789abc"],
    committerName: "score-landing",
    committerEmail: "landing@score.invalid",
    message: "Merge pull request #9 from owner/branch\n\nTitle line",
  });
});

test("observeCommit reports a root commit as parentless, not as one empty parent", async () => {
  const runner = new ScriptRunner((command, options) =>
    result(command, options, 0, "abc123\n\nscore\nscore@test.invalid\ninitial\n"),
  );

  const commit = await new GitService(runner, {
    repositoryPath: "/repo",
    workspaceRoot: "/wt",
  }).observeCommit("main");

  expect(commit.parents).toEqual([]);
});

test("abortMerge sweeps gate build residue the staged tree ignored; operator files survive (#92)", async () => {
  const { repo, git, webBranchSha } = await residueFixture();
  // Untracked operator file present before the stage — must survive.
  await writeFile(join(repo, "operator-note.md"), "keep\n");

  expect(await git.stageMerge(webBranchSha)).toBe(true);
  // The verify gate's build writes outputs only the staged tree ignores —
  // exactly how PR #68's next build left apps/web/.next in the primary.
  await mkdir(join(repo, "apps", "web", ".next", "static"), { recursive: true });
  await writeFile(join(repo, "apps", "web", ".next", "static", "chunk.js"), "built\n");
  // Operator file dropped mid-gate, not ignored — must survive too.
  await writeFile(join(repo, "mid-gate-note.md"), "keep too\n");
  await git.abortMerge();

  expect(existsSync(join(repo, "apps", "web", ".next"))).toBe(false);
  expect(existsSync(join(repo, "operator-note.md"))).toBe(true);
  expect(existsSync(join(repo, "mid-gate-note.md"))).toBe(true);
  expect(existsSync(join(repo, ".git", "score-stage-snapshot.json"))).toBe(false);
  // The #92 wedge: without the sweep these lines carried apps/web/.next dirt
  // that silently blocked mainCheckoutReady and cleanup's auto-pull.
  const { status } = await git.observePrimaryCheckout();
  expect(status).not.toContain(".next");
});

test("a pre-stage ignored path is never swept, even when the staged tree also ignores it (#92)", async () => {
  const { repo, git, webBranchSha, gitCli } = await residueFixture();
  await writeFile(join(repo, ".gitignore"), ".env\n");
  gitCli("add", ".gitignore");
  gitCli("commit", "-m", "ignore env");
  // An operator secret, ignored on main and by the staged tree alike.
  await writeFile(join(repo, ".env"), "SECRET=1\n");

  expect(await git.stageMerge(webBranchSha)).toBe(true);
  await git.abortMerge();

  expect(existsSync(join(repo, ".env"))).toBe(true);
});

test("sweepStageResidue converges from a persisted snapshot after a death mid-sweep (#92)", async () => {
  const { repo, git } = await residueFixture();
  // As left by a death between landing's abort and its sweep: no MERGE_HEAD,
  // the persisted snapshot, and the aborted gate's dirt.
  await mkdir(join(repo, "apps", "web", ".next"), { recursive: true });
  await writeFile(join(repo, "apps", "web", ".next", "chunk.js"), "built\n");
  await writeFile(
    join(repo, ".git", "score-stage-snapshot.json"),
    JSON.stringify({ before: [], stagedIgnored: ["apps/web/.next/"] }),
  );

  expect(await git.sweepStageResidue()).toEqual(["apps/web/.next"]);

  expect(existsSync(join(repo, "apps", "web", ".next"))).toBe(false);
  expect(existsSync(join(repo, ".git", "score-stage-snapshot.json"))).toBe(false);
  // Re-entry after the snapshot is retired is a no-op.
  expect(await git.sweepStageResidue()).toEqual([]);
});

test("commitMerge retires the stage snapshot so a later abort cannot sweep stale evidence (#92)", async () => {
  const { repo, git, webBranchSha } = await residueFixture();

  expect(await git.stageMerge(webBranchSha)).toBe(true);
  expect(existsSync(join(repo, ".git", "score-stage-snapshot.json"))).toBe(true);
  await git.commitMerge("Merge branch 'web-app'");

  expect(existsSync(join(repo, ".git", "score-stage-snapshot.json"))).toBe(false);
});

test("dry-run writes no stage snapshot and sweeps nothing (#92)", async () => {
  const { repo, webBranchSha } = await residueFixture();
  // ExecRunner ignores the dryRun flag (it has no mutation gate), so the
  // merge itself still runs; the assertion is that GitService writes and
  // deletes no residue evidence of its own in dry-run.
  const git = new GitService(new ExecRunner(), {
    repositoryPath: repo,
    workspaceRoot: join(repo, "wt"),
    dryRun: true,
  });

  await git.stageMerge(webBranchSha);

  expect(existsSync(join(repo, ".git", "score-stage-snapshot.json"))).toBe(false);
  expect(await git.sweepStageResidue()).toEqual([]);
});

test("a failed abort keeps the snapshot so the eventual successful abort still sweeps (#92)", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  await mkdir(join(repositoryPath, ".git"), { recursive: true });
  await mkdir(join(repositoryPath, "apps", "web", ".next"), { recursive: true });
  await writeFile(join(repositoryPath, "apps", "web", ".next", "chunk.js"), "built\n");
  await writeFile(
    join(repositoryPath, ".git", "score-stage-snapshot.json"),
    JSON.stringify({ before: [] }),
  );
  let abortWorks = false;
  let staged = true;
  const runner = new ScriptRunner((command, options) => {
    const args = command.slice(1);
    if (args[0] === "rev-parse" && args.includes("--absolute-git-dir")) {
      return result(command, options, 0, `${join(repositoryPath, ".git")}\n`);
    }
    // The MERGE_HEAD probe: in progress until the abort actually lands.
    if (args[0] === "rev-parse") return result(command, options, staged ? 0 : 1);
    if (args[0] === "merge" && args[1] === "--abort") {
      if (!abortWorks) return result(command, options, 1);
      staged = false;
      return result(command, options);
    }
    if (args[0] === "status") {
      // While staged the residue is ignored; after the abort it is plain dirt.
      return result(
        command,
        options,
        0,
        staged ? "!! apps/web/.next/\n" : "?? apps/web/.next/chunk.js\n",
      );
    }
    return result(command, options);
  });
  const git = new GitService(runner, { repositoryPath, workspaceRoot: join(root, "wt") });

  // The abort fails: the merge is still staged, so no ?? dirt exists yet —
  // sweeping now would retire the evidence and wedge the retry.
  await git.abortMerge();
  expect(existsSync(join(repositoryPath, ".git", "score-stage-snapshot.json"))).toBe(true);
  expect(existsSync(join(repositoryPath, "apps", "web", ".next", "chunk.js"))).toBe(true);

  abortWorks = true;
  await git.abortMerge();
  expect(existsSync(join(repositoryPath, "apps", "web", ".next"))).toBe(false);
  expect(existsSync(join(repositoryPath, ".git", "score-stage-snapshot.json"))).toBe(false);
});

test("stageMerge finishes a pending sweep before writing a fresh baseline (#92)", async () => {
  const { repo, git, webBranchSha } = await residueFixture();
  // As left by an abort whose sweep died or threw within the same tick:
  // snapshot with captured evidence, and the aborted gate's dirt on disk.
  await mkdir(join(repo, "apps", "web", ".next"), { recursive: true });
  await writeFile(join(repo, "apps", "web", ".next", "chunk.js"), "built\n");
  await writeFile(
    join(repo, ".git", "score-stage-snapshot.json"),
    JSON.stringify({ before: [], stagedIgnored: ["apps/web/.next/"] }),
  );

  expect(await git.stageMerge(webBranchSha)).toBe(true);

  // The old gate's residue was swept, not folded into the new baseline
  // (which would have made it permanently unsweepable).
  expect(existsSync(join(repo, "apps", "web", ".next", "chunk.js"))).toBe(false);
  const snapshot = JSON.parse(
    await readFile(join(repo, ".git", "score-stage-snapshot.json"), "utf8"),
  );
  expect(snapshot.stagedIgnored).toBeUndefined();
});

test("snapshots resolve through git, so a linked-worktree primary stages without ENOTDIR (#92)", async () => {
  const { repo, gitCli, webBranchSha } = await residueFixture();
  // A primary whose .git is a file, not a directory.
  const linkedPath = `${repo}-linked`;
  sandboxes.push(linkedPath);
  gitCli("worktree", "add", "-b", "linked-primary", linkedPath, "main");
  const git = new GitService(new ExecRunner(), {
    repositoryPath: linkedPath,
    workspaceRoot: join(linkedPath, "wt"),
  });

  expect(await git.stageMerge(webBranchSha)).toBe(true);

  // Evidence lands in the worktree's own git dir, beside its MERGE_HEAD.
  expect(
    existsSync(join(repo, ".git", "worktrees", basename(linkedPath), "score-stage-snapshot.json")),
  ).toBe(true);
  await git.abortMerge();
});

test("stageResidue: only staged-ignored entries that are new and now plain dirt qualify", () => {
  expect(
    stageResidue(
      ["operator-note.md", ".env", "logs/"],
      ["apps/web/.next/", "apps/web/.turbo/", ".env", "logs/"],
      ["apps/web/.next/static/chunk.js", "operator-note.md", "mid-gate-note.md"],
    ),
    // .turbo: still ignored after the abort (never ?? dirt) — left alone.
    // .env and logs/: predate the stage — left alone.
  ).toEqual(["apps/web/.next"]);
});

test("statusPaths filters by code and refuses git's C-quoted paths", () => {
  const status = '?? plain.md\n!! dir/\n?? "with space.md"\n';
  expect(statusPaths(status)).toEqual(["plain.md", "dir/"]);
  expect(statusPaths(status, "??")).toEqual(["plain.md"]);
});

test("seedClaudeDirectory: false leaves the worktree without a copied .claude", async () => {
  const root = await sandbox();
  const repositoryPath = join(root, "repo");
  const workspaceRoot = join(root, "wt", "repo");
  const work = identity(workspaceRoot);
  await mkdir(join(repositoryPath, ".claude"), { recursive: true });
  await writeFile(join(repositoryPath, ".claude", "settings.json"), "legacy-settings");
  const runner = new ScriptRunner(async (command, options) => {
    const args = command.slice(1);
    if (args[0] === "symbolic-ref") {
      return result(command, options, 0, "refs/remotes/origin/main\n");
    }
    if (args[0] === "show-ref") return result(command, options, 1);
    if (args[0] === "worktree") await mkdir(work.worktreePath, { recursive: true });
    return result(command, options);
  });

  await new GitService(runner, {
    repositoryPath,
    workspaceRoot,
    seedClaudeDirectory: false,
  }).createWorktree(work);

  await expect(
    readFile(join(work.worktreePath, ".claude", "settings.json"), "utf8"),
  ).rejects.toThrow();
});
