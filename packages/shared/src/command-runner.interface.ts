import type { CommandResult } from "@score/shared/command.interface";

export interface RunCommandOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly mutates?: boolean;
  readonly dryRun?: boolean;
}

/** Sole process boundary used by GitHub, Git, tmux, and verification services. */
export interface CommandRunner {
  run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult>;
}
