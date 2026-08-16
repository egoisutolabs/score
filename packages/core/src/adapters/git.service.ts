import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { WorkIdentity, WorktreeObservation } from "@score/core/dispatch/work.interface";
import type {
  LandingWorkspace,
  PrimaryCheckoutObservation,
  WorktreeProvisioner,
} from "@score/core/workspace-driver.interface";
import { requireSuccess } from "@score/shared/adapters/command-runner.service";
import type { CommandRunner } from "@score/shared/command-runner.interface";

interface GitServiceOptions {
  readonly repositoryPath: string;
  readonly workspaceRoot: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly dryRun?: boolean;
  /**
   * Copy the primary checkout's untracked .claude/ into new worktrees
   * (claude-trust seeding). Default true; composition turns it off for
   * harnesses that never read it — otherwise the seed itself makes every
   * merged-worktree cleanup report BLOCKED_DIRTY under an allowlist that
   * rightly excludes .claude/.
   */
  readonly seedClaudeDirectory?: boolean;
}

/**
 * Committer identity stamped on landing's merge commits — metadata only, the
 * author stays the checkout's configured user. Unpushed-merge recovery reads
 * it back as proof the daemon, not an operator, made a stray default-branch
 * merge (D1, issue #41).
 */
export const LANDING_COMMITTER = {
  name: "score-landing",
  email: "landing@score.invalid",
} as const;

/**
 * Evidence for abortMerge's residue sweep (#92), persisted beside MERGE_HEAD
 * (never in memory alone) so a death mid-land still sweeps: startup's
 * self-heal either aborts the still-staged merge (which re-captures
 * `stagedIgnored` fresh) or finishes an interrupted sweep from this file.
 */
interface StageSnapshot {
  /** Every path status could see before the merge was staged. */
  readonly before: readonly string[];
  /** Ignored entries while the staged tree's .gitignore files were materialized. */
  readonly stagedIgnored?: readonly string[];
}

export interface CommitObservation {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly committerName: string;
  readonly committerEmail: string;
  readonly message: string;
}

/** Local Git adapter; callers remain responsible for policy and role authorization. */
export class GitService implements WorktreeProvisioner, LandingWorkspace {
  readonly #executable: string;
  readonly #timeoutMs: number | undefined;
  /** Cached rev-parse --absolute-git-dir; the checkout's git dir never moves. */
  #gitDir: string | undefined;

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: GitServiceOptions,
  ) {
    this.#executable = this.options.executable ?? "git";
    this.#timeoutMs = this.options.timeoutMs;
  }

  async preflight(configuredDefaultBranch: string): Promise<void> {
    const root = requireSuccess(await this.#run(["rev-parse", "--show-toplevel"])).stdout.trim();
    if (root !== this.options.repositoryPath) {
      throw new Error(
        `configured repository path ${this.options.repositoryPath} resolved to ${root}`,
      );
    }
    const observedDefaultBranch = await this.discoverDefaultBranch();
    if (observedDefaultBranch !== configuredDefaultBranch) {
      throw new Error(
        `configured default branch ${configuredDefaultBranch} does not match origin/HEAD ${observedDefaultBranch}`,
      );
    }
  }

  async discoverDefaultBranch(): Promise<string> {
    const result = requireSuccess(
      await this.#run(["symbolic-ref", "refs/remotes/origin/HEAD"]),
    ).stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (!result.startsWith(prefix) || result.length === prefix.length) {
      throw new Error(`cannot derive default branch from ${result}`);
    }
    return result.slice(prefix.length);
  }

  async observeWorktrees(): Promise<readonly WorktreeObservation[]> {
    const output = requireSuccess(await this.#run(["worktree", "list", "--porcelain"])).stdout;
    return parseWorktreePorcelain(output);
  }

  /** TypeScript port of legacy/create_worktree.sh. */
  async createWorktree(identity: WorkIdentity): Promise<void> {
    this.#assertOwnedWorktreePath(identity.worktreePath);
    await mkdir(this.options.workspaceRoot, { recursive: true });
    if (await isDirectory(identity.worktreePath)) return;

    const baseBranch = await this.#resolveWorktreeBaseBranch();
    const branchExists =
      (await this.#run(["show-ref", "--verify", "--quiet", `refs/heads/${identity.branch}`]))
        .exitCode === 0;
    const worktreeArgs = branchExists
      ? ["worktree", "add", identity.worktreePath, identity.branch]
      : ["worktree", "add", "-b", identity.branch, identity.worktreePath, baseBranch];
    requireSuccess(await this.#run(worktreeArgs, true));

    if (this.options.seedClaudeDirectory === false) return;
    const claudeSource = join(this.options.repositoryPath, ".claude");
    if (await isDirectory(claudeSource)) {
      await cp(claudeSource, join(identity.worktreePath, ".claude"), { recursive: true });
    }
  }

  async status(worktreePath: string): Promise<string> {
    this.#assertOwnedWorktreePath(worktreePath);
    return requireSuccess(await this.#run(["-C", worktreePath, "status", "--porcelain"])).stdout;
  }

  async removeWorktree(worktree: WorktreeObservation): Promise<void> {
    this.#assertOwnedWorktreePath(worktree.path);
    requireSuccess(await this.#run(["worktree", "remove", "--force", worktree.path], true));
  }

  async deleteBranch(branch: string): Promise<boolean> {
    return (await this.#run(["branch", "-d", branch], true)).exitCode === 0;
  }

  async observePrimaryCheckout(): Promise<PrimaryCheckoutObservation> {
    const branch = requireSuccess(
      await this.#run(["rev-parse", "--abbrev-ref", "HEAD"]),
    ).stdout.trim();
    // Per-file untracked listing: the default mode collapses a wholly
    // untracked directory to one "?? dir/" line, which hides harness-owned
    // files (e.g. .claude/scheduled_tasks.lock) from exact-path filters and
    // would wedge landing and D1 recovery behind phantom dirt.
    const status = requireSuccess(
      await this.#run(["status", "--porcelain", "--untracked-files=all"]),
    ).stdout;
    return { branch, status };
  }

  async fetchOrigin(): Promise<void> {
    requireSuccess(await this.#run(["fetch", "origin", "--quiet"]));
  }

  async stageMerge(commit: string): Promise<boolean> {
    // Snapshot every path status can see before the staged tree materializes:
    // the residue sweep (#92) needs it to tell gate build outputs from
    // anything that predates the stage. Written before the merge so a death
    // at any later step still finds it on disk.
    if (this.options.dryRun !== true) {
      // A pending sweep (an earlier abort succeeded but its sweep died or
      // threw) must finish first: overwriting would fold that gate's residue
      // into `before` and make it permanently unsweepable.
      const pending = await this.#readStageSnapshot();
      if (pending?.stagedIgnored !== undefined) await this.sweepStageResidue();
      await this.#writeStageSnapshot({ before: statusPaths(await this.#statusWithIgnored()) });
    }
    // The exact commit, never origin/<branch>: a branch can move between
    // observation and staging, and merging an unreachable (force-pushed-away)
    // SHA fails here — which is the correct, fail-closed outcome.
    return (await this.#run(["merge", "--no-ff", "--no-commit", commit], true)).exitCode === 0;
  }

  /** A staged-but-uncommitted merge (MERGE_HEAD present) is in progress. */
  async mergeInProgress(): Promise<boolean> {
    return (await this.#run(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).exitCode === 0;
  }

  async abortMerge(): Promise<void> {
    // The staged tree's ignore rules vanish with the abort, so the sweep's
    // "ignored by the staged tree" evidence must be captured first — and
    // persisted, so a death between the abort and the sweep converges on the
    // next startup sweep instead of leaving the primary wedged (#92).
    // A capture failure must throw BEFORE the abort runs: aborting without
    // the listing loses the staged ignore rules forever (nothing could ever
    // identify the residue again), while a still-staged merge keeps its
    // MERGE_HEAD, which startup's self-heal aborts with a fresh capture.
    if (this.options.dryRun !== true) {
      const snapshot = await this.#readStageSnapshot();
      if (snapshot !== undefined) {
        await this.#writeStageSnapshot({
          ...snapshot,
          stagedIgnored: statusPaths(await this.#statusWithIgnored(), "!!"),
        });
      }
    }
    await this.#run(["merge", "--abort"], true);
    // A failed abort leaves the merge staged and the residue still ignored:
    // the sweep would see no ?? dirt yet retire the evidence, wedging the
    // eventual successful abort. Only a confirmed-gone merge sweeps.
    if (!(await this.mergeInProgress())) await this.sweepStageResidue();
  }

  /**
   * Delete build residue a staged-merge gate left behind (#92: PR #68's
   * verify gate wrote apps/web/.next into the primary; merge --abort restores
   * tracked state only, and under a HEAD without that PR's .gitignore the
   * leftovers were bare untracked dirt that silently wedged landing and
   * auto-pull for hours). Only paths meeting all three of: ignored by the
   * staged tree, absent from the pre-stage snapshot, and currently plain
   * untracked dirt — so tracked files, pre-stage operator files, unignored
   * mid-gate operator files, and anything git still ignores (.env, .turbo)
   * can never qualify. The one accepted gap: a file an operator creates
   * during the gate window under a path only the staged PR's new .gitignore
   * covers is content-free indistinguishable from gate output and is swept —
   * the primary is daemon-owned (#92), and sparing every newly-ignored path
   * would deterministically re-create the #68 wedge. Idempotent and a no-op
   * without a snapshot; startup and each landing tick call it to finish a
   * sweep a death or error interrupted.
   */
  async sweepStageResidue(): Promise<readonly string[]> {
    if (this.options.dryRun === true) return [];
    const snapshot = await this.#readStageSnapshot();
    if (snapshot === undefined) return [];
    const swept: string[] = [];
    if (snapshot.stagedIgnored !== undefined) {
      const dirt = statusPaths(await this.#statusWithIgnored(), "??");
      const residue = stageResidue(snapshot.before, snapshot.stagedIgnored, dirt);
      // Delete the untracked dirt under each residue entry, never the entry
      // directory itself: the abort can restore a tracked file into a
      // directory the staged tree wholly ignored (PR deleted its last
      // tracked file AND ignored it), and removing the directory would take
      // that restored file with it. Empty directories left behind are
      // invisible to git — no dirt, no wedge.
      for (const path of dirt) {
        if (!residue.some((entry) => path === entry || path.startsWith(`${entry}/`))) continue;
        // Status paths are repo-relative, but never feed rm without the same
        // escape check worktree paths get.
        const fromRoot = relative(
          this.options.repositoryPath,
          join(this.options.repositoryPath, path),
        );
        if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) continue;
        await rm(join(this.options.repositoryPath, fromRoot), { recursive: true, force: true });
        swept.push(fromRoot);
      }
    }
    // Retired only after the deletes: a death mid-sweep re-enters here.
    await rm(await this.#stageSnapshotPath(), { force: true });
    return swept;
  }

  async commitMerge(message: string): Promise<void> {
    // The stamp rides the environment, not -c config: inherited
    // GIT_COMMITTER_* variables outrank config, and an unstamped landing
    // merge would fail its own recovery proof after a push failure (D1
    // check 4), blocking landing indefinitely.
    requireSuccess(
      await this.#run(["-c", "commit.gpgsign=false", "commit", "-m", message], true, {
        GIT_COMMITTER_NAME: LANDING_COMMITTER.name,
        GIT_COMMITTER_EMAIL: LANDING_COMMITTER.email,
      }),
    );
    // A committed merge's build outputs are ignored by the merged tree, so
    // the snapshot is retired: a later abort must not sweep from stale
    // evidence. Best-effort: a stale {before}-only snapshot is inert (a later
    // defensive abort adds current ignore rules, and no path is both ignored
    // and plain-untracked at once), while throwing here would misreport a
    // committed merge as build-red and skip D1's push-failure guard.
    try {
      await rm(await this.#stageSnapshotPath(), { force: true });
    } catch {
      // Ignore: see above.
    }
  }

  async pushDefaultBranch(defaultBranch: string): Promise<void> {
    requireSuccess(await this.#run(["push", "origin", defaultBranch], true));
  }

  /** Parents, committer, and full message of one commit — the recovery proof's raw evidence. */
  async observeCommit(ref: string): Promise<CommitObservation> {
    const stdout = requireSuccess(
      await this.#run(["log", "-1", "--format=%H%n%P%n%cn%n%ce%n%B", ref]),
    ).stdout;
    const [sha = "", parents = "", committerName = "", committerEmail = "", ...body] =
      stdout.split("\n");
    return {
      sha,
      parents: parents === "" ? [] : parents.split(" "),
      committerName,
      committerEmail,
      // %B carries git's own trailing newline(s); strip only those.
      message: body.join("\n").replace(/\n+$/, ""),
    };
  }

  /** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    // Exit 1 means "not an ancestor"; any other failure (e.g. a bad ref) also
    // reads as unproven, which fails the recovery proof closed.
    return (await this.#run(["merge-base", "--is-ancestor", ancestor, descendant])).exitCode === 0;
  }

  /**
   * Recovery reset with both race guards a bare `reset --hard` lacks, ordered
   * tree-then-ref for failure consistency. The two-tree merge validates and
   * syncs the index/worktree while the branch still points at `expectedHead`
   * — it refuses (mutating nothing) if a file changed since the caller's
   * checks. Only then does the ref move, by compare-and-swap, so a commit
   * that arrived after observation aborts the recovery instead of being
   * discarded; the ref is never left pointing where the tree doesn't match.
   * A kill between the two steps leaves the branch on `expectedHead` with
   * the tree already at `to` — the caller detects that state and re-runs
   * this (the tree sync no-ops, the ref move completes). Pinned to exact
   * SHAs, never refs: a linked worktree's fetch can move origin/<default>
   * mid-recovery.
   */
  async resetBranchToCommit(branch: string, to: string, expectedHead: string): Promise<void> {
    requireSuccess(await this.#run(["read-tree", "-m", "-u", expectedHead, to], true));
    requireSuccess(
      await this.#run(
        [
          "update-ref",
          "-m",
          "score: D1 unpushed-merge recovery",
          `refs/heads/${branch}`,
          to,
          expectedHead,
        ],
        true,
      ),
    );
  }

  /** True when both the index and the working tree hold exactly `sha`'s tree. */
  async treeMatchesCommit(sha: string): Promise<boolean> {
    // diff --quiet: exit 1 on differences; any other failure also reads as
    // "no match", which fails the caller's recovery checks closed.
    if ((await this.#run(["diff", "--quiet", "--cached", sha])).exitCode !== 0) return false;
    return (await this.#run(["diff", "--quiet", sha])).exitCode === 0;
  }

  async fastForwardDefaultBranch(defaultBranch: string): Promise<boolean> {
    const checkout = await this.observePrimaryCheckout();
    if (checkout.branch !== defaultBranch || checkout.status.trim().length > 0) return false;
    requireSuccess(await this.#run(["pull", "--ff-only"], true));
    return true;
  }

  #assertOwnedWorktreePath(path: string): void {
    if (!isAbsolute(path)) throw new Error("worktree path must be absolute");
    const fromRoot = relative(this.options.workspaceRoot, path);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error(`worktree path is outside workspaceRoot: ${path}`);
    }
  }

  async #resolveWorktreeBaseBranch(): Promise<string> {
    const remoteHead = await this.#run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (remoteHead.exitCode === 0) {
      const prefix = "refs/remotes/origin/";
      const ref = remoteHead.stdout.trim();
      if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
    }

    for (const branch of ["main", "master"]) {
      const exists = await this.#run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (exists.exitCode === 0) return branch;
    }
    throw new Error("Could not resolve base branch (no origin/HEAD, no main, no master).");
  }

  async #statusWithIgnored(): Promise<string> {
    // --ignored=matching: an ignored directory collapses to one "!! dir/"
    // entry, the unit the sweep deletes; -uall keeps plain dirt per-file.
    // -z: NUL-delimited, unquoted paths — C-quoted names would otherwise
    // drop out of the baseline and lose their protection from the sweep.
    return requireSuccess(
      await this.#run([
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ]),
    ).stdout;
  }

  async #stageSnapshotPath(): Promise<string> {
    // Beside MERGE_HEAD, sharing its lifetime. Resolved through git, not
    // <root>/.git: a primary configured on a linked worktree or a
    // separate-git-dir layout has a .git *file*, and --absolute-git-dir is
    // exactly the directory holding that checkout's MERGE_HEAD.
    this.#gitDir ??= requireSuccess(
      await this.#run(["rev-parse", "--absolute-git-dir"]),
    ).stdout.trim();
    if (this.#gitDir === "") throw new Error("cannot resolve the repository's git directory");
    return join(this.#gitDir, "score-stage-snapshot.json");
  }

  async #writeStageSnapshot(snapshot: StageSnapshot): Promise<void> {
    // tmp+rename: a death mid-write must never leave truncated JSON where
    // valid evidence stood — an unreadable snapshot reads as "no evidence"
    // and would silently disarm the sweep.
    const path = await this.#stageSnapshotPath();
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await rename(temporary, path);
  }

  async #readStageSnapshot(): Promise<StageSnapshot | undefined> {
    // Missing or corrupt reads as "no evidence": the sweep deletes nothing.
    try {
      return JSON.parse(await readFile(await this.#stageSnapshotPath(), "utf8")) as StageSnapshot;
    } catch {
      return undefined;
    }
  }

  #run(args: readonly string[], mutates = false, env?: Readonly<Record<string, string>>) {
    return this.runner.run([this.#executable, ...args], {
      cwd: this.options.repositoryPath,
      timeoutMs: this.#timeoutMs,
      mutates,
      dryRun: this.options.dryRun,
      ...(env && { env }),
    });
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Paths from NUL-delimited (`-z`) porcelain status output, optionally only
 * those with the given XY code. -z carries paths verbatim — no C-quoting —
 * so names with spaces or non-ASCII stay in the baseline and keep their
 * protection from the sweep.
 */
export function statusPaths(status: string, code?: string): readonly string[] {
  const paths: string[] = [];
  const tokens = status.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // Shortest valid entry is "XY p": two-column code, space, path.
    if (token === undefined || token.length < 4 || token[2] !== " ") continue;
    const xy = token.slice(0, 2);
    // Rename/copy entries carry the original path as an extra NUL field.
    if (xy.includes("R") || xy.includes("C")) index += 1;
    if (code === undefined || xy === code) paths.push(token.slice(3));
  }
  return paths;
}

/** Equal, or one inside the other (porcelain directory entries end in "/"). */
function overlaps(a: string, b: string): boolean {
  const left = a.replace(/\/$/, "");
  const right = b.replace(/\/$/, "");
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Gate residue of an aborted staged merge (#92): staged-tree-ignored entries
 * that overlap nothing from before the stage and now cover plain untracked
 * dirt. Requiring current ?? dirt is the safety keystone — anything git still
 * ignores or tracks can never qualify. ponytail: an entry overlapping any
 * pre-stage path is skipped wholesale (its dirt stays, loudly) instead of
 * swept file-by-file.
 */
export function stageResidue(
  before: readonly string[],
  stagedIgnored: readonly string[],
  dirtAfter: readonly string[],
): readonly string[] {
  return stagedIgnored
    .map((entry) => entry.replace(/\/$/, ""))
    .filter((entry) => !before.some((path) => overlaps(entry, path)))
    .filter((entry) => dirtAfter.some((path) => overlaps(entry, path)));
}

export function parseWorktreePorcelain(output: string): readonly WorktreeObservation[] {
  const worktrees: WorktreeObservation[] = [];
  let current: { path?: string; branch?: string; headSha?: string; locked?: boolean } | undefined;

  const finish = () => {
    if (current?.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? "",
        headSha: current.headSha,
        locked: current.locked ?? false,
      });
    }
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      finish();
      current = { path: line.slice("worktree ".length), locked: false };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line.startsWith("HEAD ")) {
      current.headSha = line.slice("HEAD ".length);
    } else if (current && line === "locked") {
      current.locked = true;
    }
  }
  finish();
  return worktrees;
}
