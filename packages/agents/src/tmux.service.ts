import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
// node:timers/promises, not Bun.sleep: the vitest suite runs this under Node.
import { setTimeout as sleep } from "node:timers/promises";

import { defaultClaudeConfigPath, preseedWorktreeTrust } from "@score/agents/claude-trust";
import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { repairSessionName } from "@score/core/dispatch/dispatch.identity";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import { requireSuccess } from "@score/shared/adapters/command-runner.service";
import { agentArgv } from "@score/shared/agent-command";
import type { CommandRunner } from "@score/shared/command-runner.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";

interface TmuxServiceOptions {
  readonly repositoryPath: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly dryRun?: boolean;
  /** Overridden in tests so they never touch the real ~/.claude.json. */
  readonly trustConfigPath?: string;
  /** Managed mode: project key namespacing the repair sessions this adapter creates. */
  readonly namespace?: string;
  /** Managed mode: durable home for repair prompt files; /tmp otherwise. */
  readonly promptsDir?: string;
  /**
   * Wait before the birth liveness check. No legitimate agent finishes inside
   * it, so a pane that died within it is a launch failure. Overridden small
   * in tests.
   */
  readonly birthGraceMs?: number;
}

/** Durable local process adapter using argv-safe tmux commands. */
export class TmuxService implements AgentRuntime {
  readonly #executable: string;
  readonly #timeoutMs: number | undefined;
  readonly #birthGraceMs: number;

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: TmuxServiceOptions,
  ) {
    this.#executable = this.options.executable ?? "tmux";
    this.#timeoutMs = this.options.timeoutMs;
    this.#birthGraceMs = this.options.birthGraceMs ?? 3_000;
  }

  async preflight(): Promise<void> {
    requireSuccess(await this.#run(["-V"]));
  }

  async sessionExists(sessionName: string): Promise<boolean> {
    const result = await this.#run(["has-session", "-t", sessionName]);
    return result.exitCode === 0;
  }

  async listSessions(): Promise<readonly string[]> {
    const result = await this.#run(["list-sessions", "-F", "#{session_name}"]);
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }

  /** TypeScript port of legacy/launch_session.sh's active Claude path. */
  async startImplementation(
    identity: WorkIdentity,
    prompt: string,
    agent: AgentConfig,
  ): Promise<void> {
    if (!(await isDirectory(identity.worktreePath))) {
      throw new Error(`worktree not found: ${identity.worktreePath}`);
    }
    if (await this.sessionExists(identity.sessionName)) {
      throw new Error(
        `tmux session '${identity.sessionName}' already exists. Attach with: tmux attach -t ${identity.sessionName}`,
      );
    }

    await this.#preseedTrust(identity.worktreePath);
    await this.#spawnHeldSession(identity.sessionName, [
      "new-session",
      "-d",
      "-s",
      identity.sessionName,
      "-c",
      identity.worktreePath,
      encodeTmuxShellCommand(agentArgv(agent, prompt)),
      ...remainOnExit(identity.sessionName),
    ]);
    await this.#assertBornAlive(identity.sessionName, false);
  }

  async ping(sessionName: string, message: string): Promise<void> {
    requireSuccess(await this.#run(["send-keys", "-t", sessionName, "C-u"], true));
    requireSuccess(await this.#run(["send-keys", "-t", sessionName, "-l", message], true));
    await Bun.sleep(1_000);
    requireSuccess(await this.#run(["send-keys", "-t", sessionName, "Enter"], true));
    await Bun.sleep(1_000);
    requireSuccess(await this.#run(["send-keys", "-t", sessionName, "Enter"], true));
  }

  async startRepair(
    pullRequestNumber: number,
    worktreePath: string,
    message: string,
    agent: AgentConfig,
  ): Promise<void> {
    const sessionName = repairSessionName(this.options.namespace, pullRequestNumber);
    // /tmp dies on reboot; a managed project parks prompts in its prompts/ dir.
    const promptPath = join(
      this.options.promptsDir ?? "/tmp",
      `shepherd-pr-${pullRequestNumber}.prompt`,
    );
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, `${message}\n`);
    await this.#preseedTrust(worktreePath);
    await this.#run(["kill-session", "-t", sessionName], true);
    // The prompt reaches the agent via $(cat) inside the preserved legacy
    // wrapper, so agentArgv's copy of it is dropped (it is always last).
    const agentCommand = encodeTmuxShellCommand(agentArgv(agent, message).slice(0, -1));
    const shell = `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; export GITHUB_TOKEN="$(gh auth token)"; ${agentCommand} "$(cat '${promptPath}')" --permission-mode bypassPermissions; echo EXIT:$?; echo '--- done; press enter to close ---'; read`;
    await this.#spawnHeldSession(sessionName, [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      worktreePath,
      "bash",
      "-lc",
      shell,
      ...remainOnExit(sessionName),
    ]);
    await this.#assertBornAlive(sessionName, true);
  }

  async stop(sessionName: string): Promise<void> {
    await this.#run(["kill-session", "-t", sessionName], true);
  }

  /**
   * new-session and the chained remain-on-exit set share one exit status, so
   * a failure can still have created the session with a live agent inside.
   * Reclaim before throwing: the caller's rollback deletes the worktree, and
   * a stranded session would block every retry as ALREADY_IN_FLIGHT. The
   * kill is harmless when the session was never created.
   */
  async #spawnHeldSession(sessionName: string, args: readonly string[]): Promise<void> {
    const spawn = await this.#run(args, true);
    // "duplicate session" means new-session created nothing — the name was
    // taken by a session some other actor owns, and reclaiming would kill
    // THEIR live work; preserve the plain launch-conflict throw for that.
    if (
      !spawn.dryRun &&
      (spawn.exitCode !== 0 || spawn.timedOut) &&
      !spawn.stderr.includes("duplicate session")
    ) {
      const killed = await this.#run(["kill-session", "-t", sessionName], true);
      // Same surfacing as the birth-check paths: a partially-created session
      // that survives its kill blocks every retry as ALREADY_IN_FLIGHT —
      // name it rather than throwing a spawn error that hides it.
      if (killed.exitCode !== 0 && (await this.sessionExists(sessionName))) {
        throw new Error(
          `spawning tmux session '${sessionName}' failed (exit ${spawn.exitCode}${spawn.timedOut ? " after timing out" : ""}), and the partially-created session could not be killed and will block retries — run: tmux kill-session -t ${sessionName}`,
        );
      }
    }
    requireSuccess(spawn);
  }

  /**
   * Birth check (#45): an agent that dies within the grace window otherwise
   * vanishes silently — the session closes, dispatch already reported
   * success, and the leftover worktree blocks every retry. The session is
   * spawned with remain-on-exit on so the dead pane survives long enough to
   * be read here; dead → capture its dying output, reclaim the session, and
   * throw so the caller's rollback fires with the agent's actual error.
   * Alive → remain-on-exit goes back off, restoring today's
   * exit-closes-session behavior. `wrapperExitMarker` (repair only): the
   * repair wrapper's bash never exits (it parks at `read`), so its `EXIT:<n>`
   * echo inside the grace window is the equivalent death signal there — never
   * checked for implementation panes, where arbitrary live TUI content could
   * collide with the pattern.
   */
  async #assertBornAlive(sessionName: string, wrapperExitMarker: boolean): Promise<void> {
    if (this.options.dryRun) return;
    await sleep(this.#birthGraceMs);
    const panes = await this.#run(["list-panes", "-t", sessionName, "-F", "#{pane_dead}"]);
    // A timed-out liveness probe is an unresponsive server, not proof of
    // death. Killing a possibly-live agent over an observation failure is
    // strictly worse than missing a death (which merely degrades to the
    // pre-birth-check behavior), so fail open, best-effort restoring normal
    // exit behavior.
    if (panes.timedOut) {
      await this.#run(["set-option", "-t", sessionName, "remain-on-exit", "off"], true);
      return;
    }
    // list-panes failing cleanly means the session is gone entirely
    // (remain-on-exit could not hold it) — dead by definition.
    const paneDead = panes.exitCode !== 0 || panes.stdout.includes("1");
    const capture = await this.#run(["capture-pane", "-p", "-t", sessionName]);
    // A capture timeout only blinds the EXIT-marker check, never the verdict:
    // a confirmed-dead pane stays dead (just with no output to report), and a
    // confirmed-alive pane fails open exactly as above.
    if (!paneDead && capture.timedOut) {
      await this.#run(["set-option", "-t", sessionName, "remain-on-exit", "off"], true);
      return;
    }
    let dead = paneDead || (wrapperExitMarker && /^EXIT:\d+/m.test(capture.stdout));
    if (!dead) {
      const restore = await this.#run(
        ["set-option", "-t", sessionName, "remain-on-exit", "off"],
        true,
      );
      // A failed restore still throws (the session would linger forever once
      // its agent exits), but the live agent must not survive it: the caller's
      // rollback deletes the worktree under it, and the session would block
      // every retry as ALREADY_IN_FLIGHT. Reclaim first, then propagate —
      // and if the reclaim itself fails with the session surviving, name the
      // blocker in the error (same surfacing as the dead path below) instead
      // of throwing one that hides it.
      if (restore.exitCode !== 0 || restore.timedOut) {
        const killed = await this.#run(["kill-session", "-t", sessionName], true);
        if (killed.exitCode !== 0 && (await this.sessionExists(sessionName))) {
          throw new Error(
            `could not restore exit behavior for tmux session '${sessionName}' (set-option exited ${restore.exitCode}${restore.timedOut ? " after timing out" : ""}), and the session could not be killed and will block retries — run: tmux kill-session -t ${sessionName}`,
          );
        }
      }
      requireSuccess(restore);
      // The alive verdict was sampled before the restore landed; a death in
      // that gap still ran under remain-on-exit and would linger as a dead
      // pane forever. From the restore onward deaths close the session
      // normally, so one re-probe completes the PANE-death verdict for the
      // whole window. The repair EXIT marker keeps its sampled-once
      // semantics deliberately: the wrapper parks at `read` either way, so
      // there is always a final observation with an irreducible tail after
      // it, and a death in that tail changes no session state — catching it
      // is repair-staleness territory, not the birth check's.
      // Timed out → unknown, fail open as above.
      const recheck = await this.#run(["list-panes", "-t", sessionName, "-F", "#{pane_dead}"]);
      dead = !recheck.timedOut && (recheck.exitCode !== 0 || recheck.stdout.includes("1"));
      if (!dead) return;
    }
    const killed = await this.#run(["kill-session", "-t", sessionName], true);
    // A remain-on-exit session never dies on its own, so a failed kill that
    // leaves it behind would block every retry as ALREADY_IN_FLIGHT — name
    // that in the error instead of silently ignoring the kill result.
    const lingering = killed.exitCode !== 0 && (await this.sessionExists(sessionName));
    const output = capture.stdout.trim().split("\n").filter(Boolean).slice(-15).join("\n");
    throw new Error(
      `agent died at birth in tmux session '${sessionName}'${
        lingering
          ? ` (dead session could not be killed and will block retries — run: tmux kill-session -t ${sessionName})`
          : ""
      }${output ? `: ${output}` : " (no output captured)"}`,
    );
  }

  async #preseedTrust(worktreePath: string): Promise<void> {
    if (this.options.dryRun) return;
    await preseedWorktreeTrust(
      worktreePath,
      this.options.trustConfigPath ?? defaultClaudeConfigPath(),
    );
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

/**
 * tmux command-sequence suffix setting remain-on-exit in the same invocation
 * as new-session — set separately, an instant death could close the session
 * before the option lands.
 */
function remainOnExit(sessionName: string): readonly string[] {
  return [";", "set-option", "-t", sessionName, "remain-on-exit", "on"];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** tmux accepts one shell-command string, so argv is encoded with POSIX-safe quoting here only. */
export function encodeTmuxShellCommand(command: readonly string[]): string {
  if (command.length === 0) throw new Error("agent command cannot be empty");
  return command.map((argument) => `'${argument.replaceAll("'", `'"'"'`)}'`).join(" ");
}
