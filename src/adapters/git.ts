import { cp, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { requireSuccess } from "@/adapters/command-runner";
import type { WorkIdentity, WorktreeObservation } from "@/features/dispatch/work";
import type { CommandRunner } from "@/shared/command-runner";
import type { PrimaryCheckoutObservation, WorkspaceDriver } from "@/shared/workspace-driver";

interface GitServiceOptions {
  readonly repositoryPath: string;
  readonly workspaceRoot: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly dryRun?: boolean;
}

/** Local Git adapter; callers remain responsible for policy and role authorization. */
export class GitService implements WorkspaceDriver {
  readonly #executable: string;
  readonly #timeoutMs: number | undefined;

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
    const status = requireSuccess(await this.#run(["status", "--porcelain"])).stdout;
    return { branch, status };
  }

  async fetchOrigin(): Promise<void> {
    requireSuccess(await this.#run(["fetch", "origin", "--quiet"]));
  }

  async stageMerge(remoteBranch: string): Promise<boolean> {
    return (
      (await this.#run(["merge", "--no-ff", "--no-commit", `origin/${remoteBranch}`], true))
        .exitCode === 0
    );
  }

  /** A staged-but-uncommitted merge (MERGE_HEAD present) is in progress. */
  async mergeInProgress(): Promise<boolean> {
    return (await this.#run(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).exitCode === 0;
  }

  async abortMerge(): Promise<void> {
    await this.#run(["merge", "--abort"], true);
  }

  async commitMerge(message: string): Promise<void> {
    requireSuccess(await this.#run(["-c", "commit.gpgsign=false", "commit", "-m", message], true));
  }

  async pushDefaultBranch(defaultBranch: string): Promise<void> {
    requireSuccess(await this.#run(["push", "origin", defaultBranch], true));
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

  #run(args: readonly string[], mutates = false) {
    return this.runner.run([this.#executable, ...args], {
      cwd: this.options.repositoryPath,
      timeoutMs: this.#timeoutMs,
      mutates,
      dryRun: this.options.dryRun,
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
