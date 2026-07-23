import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireSuccess } from "@/adapters/command-runner";
import type { JobStatus, SupervisorAdapter } from "@/features/supervisor/adapter";
import { jobLabel, LABEL_PREFIX } from "@/features/supervisor/plist";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner } from "@/shared/command-runner";

const PLIST_SUFFIX = ".plist";
/** launchctl reports errno; 3 is ESRCH — booting out a job that isn't loaded. */
const LAUNCHCTL_NO_SUCH_PROCESS = 3;

export interface LaunchdOptions {
  /** gui domain uid; defaults to the current user. */
  readonly uid?: number;
  /** Defaults to ~/Library/LaunchAgents. */
  readonly launchAgentsDir?: string;
}

/** SupervisorAdapter over `launchctl`, argv-only through the CommandRunner. */
export class LaunchdSupervisor implements SupervisorAdapter {
  private readonly uid: number;
  private readonly agentsDir: string;

  constructor(
    private readonly runner: CommandRunner,
    options: LaunchdOptions = {},
  ) {
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.agentsDir = options.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  }

  private plistPath(key: string): string {
    return join(this.agentsDir, `${jobLabel(key)}${PLIST_SUFFIX}`);
  }

  private serviceTarget(key: string): string {
    return `gui/${this.uid}/${jobLabel(key)}`;
  }

  private launchctl(args: readonly string[], mutates: boolean): Promise<CommandResult> {
    return this.runner.run(["launchctl", ...args], {
      cwd: this.agentsDir,
      mutates,
      timeoutMs: 30_000,
    });
  }

  async install(key: string, definition: string): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
    await writeFile(this.plistPath(key), definition, "utf8");
    requireSuccess(
      await this.launchctl(["bootstrap", `gui/${this.uid}`, this.plistPath(key)], true),
    );
  }

  async uninstall(key: string): Promise<void> {
    await this.stop(key);
    await rm(this.plistPath(key), { force: true });
  }

  async start(key: string): Promise<void> {
    requireSuccess(await this.launchctl(["kickstart", this.serviceTarget(key)], true));
  }

  async stop(key: string): Promise<void> {
    const result = await this.launchctl(["bootout", this.serviceTarget(key)], true);
    // Not loaded is fine — stop/down must be idempotent.
    if (result.exitCode !== 0 && result.exitCode !== LAUNCHCTL_NO_SUCH_PROCESS) {
      requireSuccess(result);
    }
  }

  async status(): Promise<JobStatus[]> {
    const list = requireSuccess(await this.launchctl(["list"], false));
    const jobs = new Map<string, JobStatus>();
    // `launchctl list` lines: PID (or -), last exit status, label.
    for (const line of list.stdout.split("\n")) {
      const [pid, , label] = line.trim().split(/\s+/);
      if (label === undefined || !label.startsWith(LABEL_PREFIX)) continue;
      const key = label.slice(LABEL_PREFIX.length);
      const parsedPid = Number(pid);
      jobs.set(key, { key, loaded: true, ...(Number.isInteger(parsedPid) && { pid: parsedPid }) });
    }
    let files: string[] = [];
    try {
      files = await readdir(this.agentsDir);
    } catch {
      // No LaunchAgents dir yet — nothing installed.
    }
    for (const file of files) {
      if (!file.startsWith(LABEL_PREFIX) || !file.endsWith(PLIST_SUFFIX)) continue;
      const key = file.slice(LABEL_PREFIX.length, -PLIST_SUFFIX.length);
      if (!jobs.has(key)) jobs.set(key, { key, loaded: false });
    }
    return [...jobs.values()];
  }
}
