import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultClaudeConfigPath, preseedWorktreeTrust } from "@/adapters/claude-trust";
import { requireSuccess } from "@/adapters/command-runner";
import type { AgentConfig } from "@/features/config/model";
import { repairSessionName } from "@/features/dispatch/identity";
import type { WorkIdentity } from "@/features/dispatch/work";
import { agentArgv } from "@/shared/agent-command";
import type { AgentRuntime } from "@/shared/agent-runtime";
import type { CommandRunner } from "@/shared/command-runner";

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
}

/** Durable local process adapter using argv-safe tmux commands. */
export class TmuxService implements AgentRuntime {
  readonly #executable: string;
  readonly #timeoutMs: number | undefined;

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: TmuxServiceOptions,
  ) {
    this.#executable = this.options.executable ?? "tmux";
    this.#timeoutMs = this.options.timeoutMs;
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
    requireSuccess(
      await this.#run(
        [
          "new-session",
          "-d",
          "-s",
          identity.sessionName,
          "-c",
          identity.worktreePath,
          encodeTmuxShellCommand(agentArgv(agent, prompt)),
        ],
        true,
      ),
    );
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
    requireSuccess(
      await this.#run(
        ["new-session", "-d", "-s", sessionName, "-c", worktreePath, "bash", "-lc", shell],
        true,
      ),
    );
  }

  async stop(sessionName: string): Promise<void> {
    await this.#run(["kill-session", "-t", sessionName], true);
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
