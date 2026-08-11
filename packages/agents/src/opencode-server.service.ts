import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const DEFAULT_STARTUP_DEADLINE_MS = 10_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const LISTENING_PREFIX = "opencode server listening on ";

export interface OpencodeServerOptions {
  readonly executable?: string;
  /** Bounds both the URL-print wait and the /doc poll, start to finish. */
  readonly startupDeadlineMs?: number;
  /** Grace between SIGTERM and SIGKILL escalation in stop(). */
  readonly stopGraceMs?: number;
}

export interface OpencodeServerHandle {
  readonly baseUrl: string;
  /** Settles only if the child dies without stop() having been requested. */
  readonly unexpectedExit: Promise<void>;
  stop(): Promise<void>;
}

interface ManagedChild {
  readonly process: ChildProcessByStdio<null, Readable, null>;
  readonly exited: Promise<void>;
  hasExited(): boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnChild(executable: string): ManagedChild {
  const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let exited = false;
  // Armed before any await: a child that dies before we ever look never
  // slips past the stopRequested gate that decides expected vs unexpected.
  const exitedPromise = new Promise<void>((resolve) => {
    child.on("error", () => {
      exited = true;
      resolve();
    });
    child.on("exit", () => {
      exited = true;
      resolve();
    });
  });
  return { process: child, exited: exitedPromise, hasExited: () => exited };
}

function bufferStdout(managed: ManagedChild): () => string {
  let buffer = "";
  managed.process.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
  });
  return () => buffer;
}

/**
 * Owns exactly one `opencode serve` child: start() resolves once the base URL
 * is known and /doc answers, stop() is idempotent and bounded. This class
 * never goes through CommandRunner.run — that abstraction is for bounded
 * run-to-completion commands, not a child that must outlive a single call.
 */
export class OpencodeServer {
  readonly #executable: string;
  readonly #startupDeadlineMs: number;
  readonly #stopGraceMs: number;

  #started = false;
  #child: ManagedChild | undefined;
  #stopRequested = false;
  #stopPromise: Promise<void> | undefined;
  #resolveUnexpectedExit!: () => void;
  readonly #unexpectedExit: Promise<void>;

  constructor(options: OpencodeServerOptions = {}) {
    if (options.startupDeadlineMs !== undefined && options.startupDeadlineMs <= 0) {
      throw new Error("startupDeadlineMs must be positive");
    }
    if (options.stopGraceMs !== undefined && options.stopGraceMs <= 0) {
      throw new Error("stopGraceMs must be positive");
    }
    this.#executable = options.executable ?? "opencode";
    this.#startupDeadlineMs = options.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.#unexpectedExit = new Promise((resolve) => {
      this.#resolveUnexpectedExit = resolve;
    });
  }

  async start(): Promise<OpencodeServerHandle> {
    if (this.#started) throw new Error("OpencodeServer.start() already called");
    this.#started = true;

    const managed = spawnChild(this.#executable);
    this.#child = managed;
    const readBuffer = bufferStdout(managed);
    managed.exited.then(() => {
      if (!this.#stopRequested) this.#resolveUnexpectedExit();
    });

    const deadlineAt = Date.now() + this.#startupDeadlineMs;
    try {
      const baseUrl = await this.#readListeningUrl(managed, readBuffer, deadlineAt);
      await this.#awaitDocReady(baseUrl, managed, deadlineAt);
      if (this.#stopRequested) {
        throw new Error("opencode server stop requested during startup");
      }
      return {
        baseUrl,
        unexpectedExit: this.#unexpectedExit,
        stop: () => this.stop(),
      };
    } catch (error) {
      // Readiness failure kills the child before throwing — startup never
      // leaks a process, regardless of which phase failed.
      await this.#kill(managed);
      throw error;
    }
  }

  /** Idempotent: repeat calls await the same completion; never fires unexpectedExit. */
  async stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopRequested = true;
    const managed = this.#child;
    this.#stopPromise = managed ? this.#kill(managed) : Promise.resolve();
    return this.#stopPromise;
  }

  async #readListeningUrl(
    managed: ManagedChild,
    readBuffer: () => string,
    deadlineAt: number,
  ): Promise<string> {
    let consumed = 0;
    for (;;) {
      if (this.#stopRequested) {
        throw new Error("opencode server stop requested before it printed a listening URL");
      }
      const buffer = readBuffer();
      const newlineIndex = buffer.indexOf("\n", consumed);
      if (newlineIndex !== -1) {
        const line = buffer.slice(consumed, newlineIndex).trim();
        consumed = newlineIndex + 1;
        if (line.startsWith(LISTENING_PREFIX)) {
          return line.slice(LISTENING_PREFIX.length).trim();
        }
        continue;
      }
      if (managed.hasExited()) {
        throw new Error("opencode server exited before printing a listening URL");
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `opencode server did not print a listening URL within ${this.#startupDeadlineMs}ms`,
        );
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
    }
  }

  async #awaitDocReady(baseUrl: string, managed: ManagedChild, deadlineAt: number): Promise<void> {
    for (;;) {
      if (this.#stopRequested) {
        throw new Error("opencode server stop requested before /doc became ready");
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`opencode /doc did not become ready within ${this.#startupDeadlineMs}ms`);
      }
      if (await this.#probeDoc(baseUrl, remainingMs)) return;
      if (managed.hasExited()) {
        throw new Error("opencode server exited before /doc became ready");
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
    }
  }

  async #probeDoc(baseUrl: string, timeoutMs: number): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/doc`, { signal: AbortSignal.timeout(timeoutMs) });
      await response.text();
      return response.ok;
    } catch {
      return false;
    }
  }

  async #kill(managed: ManagedChild): Promise<void> {
    if (managed.hasExited()) return;
    managed.process.kill("SIGTERM");
    const exitedInTime = await Promise.race([
      managed.exited.then(() => true),
      sleep(this.#stopGraceMs).then(() => false),
    ]);
    if (!exitedInTime && !managed.hasExited()) {
      managed.process.kill("SIGKILL");
      await managed.exited;
    }
  }
}
