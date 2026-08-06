import { spawn } from "node:child_process";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import type { Logger } from "@score/shared/log";

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

export interface BunCommandRunnerOptions {
  /** Applied when a call passes no timeoutMs — every command is bounded by default. */
  readonly defaultTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL, and again before the hard-stop return. */
  readonly killGraceMs?: number;
}

/**
 * Argv runner with bounded execution and an explicit dry-run mutation gate.
 * Every command gets a deadline: a hung gh, git, tmux, or verify gate must
 * never wedge the daemon mid-phase, where the SIGTERM stop-check between
 * phases can't reach and launchd sees a live process. Children are spawned
 * detached into their own process group so the deadline kills the whole tree
 * (`sh -c "make verify"` included), and stream collection after exit is
 * bounded too — an orphan holding our pipe cannot hang the await.
 */
export class BunCommandRunner implements CommandRunner {
  readonly #defaultTimeoutMs: number;
  readonly #killGraceMs: number;

  constructor(options: BunCommandRunnerOptions = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.#killGraceMs = options.killGraceMs ?? 5_000;
  }

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

    const child = spawn(command[0] as string, command.slice(1), {
      cwd: options.cwd,
      env: options.env ? { ...processEnv(), ...options.env } : processEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so the deadline can kill the whole tree.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };

    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    let timedOut = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        timers.push(setTimeout(() => killTree("SIGKILL"), this.#killGraceMs));
      }, timeoutMs),
    );

    // Both listeners armed at spawn time — registering `close` only after
    // awaiting `exit` loses the event when it fires in between.
    const exited = new Promise<number>((resolve) => {
      child.on("error", (error) => {
        stderr += `${stderr ? "\n" : ""}${error.message}`;
        resolve(-1);
      });
      child.on("exit", (code) => resolve(code ?? -1));
    });
    const closed = new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });
    const exitCode = await exited;
    // Streams normally close with the process; give stragglers one grace
    // period, then return with what was captured rather than waiting on an
    // orphan that inherited our pipe.
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, this.#killGraceMs));
      }),
    ]);
    for (const timer of timers) clearTimeout(timer);

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
