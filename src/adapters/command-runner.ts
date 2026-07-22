import type { CommandResult } from "@/shared/command";
import type { CommandRunner, RunCommandOptions } from "@/shared/command-runner";
import type { Logger } from "@/shared/log";

export class CommandExecutionError extends Error {
  constructor(readonly result: CommandResult) {
    super(
      `${result.command.join(" ")} exited ${result.exitCode}${result.timedOut ? " after timing out" : ""}\n${result.stderr}`.trim(),
    );
    this.name = "CommandExecutionError";
  }
}

export function requireSuccess(result: CommandResult): CommandResult {
  if (result.exitCode !== 0 || result.timedOut) throw new CommandExecutionError(result);
  return result;
}

/** Traces every process the daemon runs; legacy's `$ cmd` debug lines lived in run(). */
export class LoggingCommandRunner implements CommandRunner {
  constructor(
    private readonly inner: CommandRunner,
    private readonly log: Logger,
  ) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.log.debug(`$ ${command.join(" ")}`);
    const result = await this.inner.run(command, options);
    if (result.dryRun) {
      // Domain renderers already say what would happen ("would start issue #N"); keep this at debug.
      this.log.debug(`(dry-run) would run: ${result.command.join(" ")}`);
      return result;
    }
    if (result.timedOut) {
      this.log.warn(`timed out: ${result.command.join(" ")}`);
    } else if (result.exitCode !== 0) {
      this.log.debug(`exit ${result.exitCode}: ${result.command.join(" ")}`);
    }
    const stderr = result.stderr.trim();
    if (stderr) this.log.debug(stderr);
    return result;
  }
}

/** Bun-backed argv runner with bounded execution and an explicit dry-run mutation gate. */
export class BunCommandRunner implements CommandRunner {
  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    if (command.length === 0) throw new Error("command cannot be empty");
    if (options.dryRun && options.mutates) {
      return {
        command: [...command],
        cwd: options.cwd,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        dryRun: true,
      };
    }

    const process = Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.env ? { ...processEnv(), ...options.env } : processEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            process.kill();
          }, options.timeoutMs);

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });

    return {
      command: [...command],
      cwd: options.cwd,
      exitCode,
      stdout,
      stderr,
      timedOut,
      dryRun: false,
    };
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
