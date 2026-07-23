import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireSuccess } from "@/adapters/command-runner";
import { crashLogPath } from "@/features/config/layout";
import type { ResolvedProject } from "@/features/config/model";
import type { JobStatus, SupervisorAdapter } from "@/features/supervisor/adapter";
import { EXIT_TIMEOUT_SECONDS, THROTTLE_INTERVAL_SECONDS } from "@/features/supervisor/plist";
import type { CommandResult } from "@/shared/command";
import type { CommandRunner } from "@/shared/command-runner";

/** Unit namespace: `score down` with no key touches these units and nothing else. */
export const UNIT_PREFIX = "score-";
const UNIT_SUFFIX = ".service";
/** systemctl exit code for a unit it has never loaded — stop/down must be idempotent. */
const SYSTEMCTL_NOT_LOADED = 5;

export function unitName(key: string): string {
  return `${UNIT_PREFIX}${key}${UNIT_SUFFIX}`;
}

/** `%` starts a systemd specifier; escape it wherever a path or value lands. */
function specifierEscape(value: string): string {
  return value.replaceAll("%", "%%");
}

/** One double-quoted ExecStart/Environment word, per systemd.syntax(7). */
function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

/**
 * Pure systemd user-unit definition, the launchd plist's 1:1 twin:
 * ProgramArguments→ExecStart, KeepAlive→Restart=on-failure,
 * ThrottleInterval→RestartSec, ExitTimeOut→TimeoutStopSec,
 * StandardOutPath→StandardOutput=append:.
 *
 * User units die at logout unless lingering is enabled — operators must run
 * `loginctl enable-linger $USER` once. Documented here and in the README, not
 * checked by doctor (doctor stays minimal by design).
 */
export function renderUnit(
  project: ResolvedProject,
  invocation: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): string {
  const log = crashLogPath(project.key);
  const environmentLines = Object.entries(environment)
    .map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}\n`)
    .join("");
  return `# Survives logout only with lingering enabled: loginctl enable-linger $USER
[Unit]
Description=score daemon (${project.key})

[Service]
ExecStart=${invocation.map(quoted).join(" ")}
WorkingDirectory=${specifierEscape(project.mainLocation)}
${environmentLines}Restart=on-failure
RestartSec=${THROTTLE_INTERVAL_SECONDS}
TimeoutStopSec=${EXIT_TIMEOUT_SECONDS}
StandardOutput=append:${specifierEscape(log)}
StandardError=append:${specifierEscape(log)}

[Install]
WantedBy=default.target
`;
}

export interface SystemdOptions {
  /** Defaults to ~/.config/systemd/user. */
  readonly unitDir?: string;
}

/** SupervisorAdapter over `systemctl --user`, argv-only through the CommandRunner. */
export class SystemdSupervisor implements SupervisorAdapter {
  private readonly unitDir: string;

  constructor(
    private readonly runner: CommandRunner,
    options: SystemdOptions = {},
  ) {
    this.unitDir = options.unitDir ?? join(homedir(), ".config", "systemd", "user");
  }

  private unitPath(key: string): string {
    return join(this.unitDir, unitName(key));
  }

  private systemctl(args: readonly string[], mutates: boolean): Promise<CommandResult> {
    // cwd "/" — unitDir may not exist yet (status/stop run before install
    // creates it), and a missing cwd fails the spawn itself.
    return this.runner.run(["systemctl", "--user", ...args], {
      cwd: "/",
      mutates,
      timeoutMs: 30_000,
    });
  }

  async install(key: string, definition: string): Promise<void> {
    await mkdir(this.unitDir, { recursive: true });
    await writeFile(this.unitPath(key), definition, "utf8");
    requireSuccess(await this.systemctl(["daemon-reload"], true));
    requireSuccess(await this.systemctl(["enable", "--now", unitName(key)], true));
  }

  async uninstall(key: string): Promise<void> {
    const result = await this.systemctl(["disable", "--now", unitName(key)], true);
    if (result.exitCode !== 0) {
      // A unit systemd never saw fails disable — fine, down must be idempotent.
      const fileExists = await stat(this.unitPath(key)).then(
        () => true,
        () => false,
      );
      if (fileExists) requireSuccess(result);
    }
    await rm(this.unitPath(key), { force: true });
  }

  async start(key: string): Promise<void> {
    requireSuccess(await this.systemctl(["start", unitName(key)], true));
  }

  async stop(key: string): Promise<void> {
    const result = await this.systemctl(["stop", unitName(key)], true);
    // Not loaded is fine — stop/down must be idempotent.
    if (result.exitCode !== 0 && result.exitCode !== SYSTEMCTL_NOT_LOADED) {
      requireSuccess(result);
    }
  }

  async status(): Promise<JobStatus[]> {
    let files: string[] = [];
    try {
      files = await readdir(this.unitDir);
    } catch {
      // No unit dir yet — nothing installed.
    }
    const keys = files
      .filter((file) => file.startsWith(UNIT_PREFIX) && file.endsWith(UNIT_SUFFIX))
      .map((file) => file.slice(UNIT_PREFIX.length, -UNIT_SUFFIX.length));
    if (keys.length === 0) return [];
    const show = requireSuccess(
      await this.systemctl(
        ["show", "--property=Id,ActiveState,MainPID", ...keys.map(unitName)],
        false,
      ),
    );
    // `show` emits one Key=Value block per unit, blank-line separated.
    const byId = new Map<string, Record<string, string>>();
    for (const block of show.stdout.split("\n\n")) {
      const props: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
      }
      if (props.Id !== undefined) byId.set(props.Id, props);
    }
    return keys.map((key) => {
      const props = byId.get(unitName(key));
      // inactive covers deliberately-stopped and not-found alike: definition
      // only. active/activating/failed all mean systemd holds a live
      // registration (failed = crashed, mirroring launchd's loaded-no-pid).
      const loaded = props !== undefined && props.ActiveState !== "inactive";
      const pid = Number(props?.MainPID);
      return { key, loaded, ...(loaded && Number.isInteger(pid) && pid > 0 && { pid }) };
    });
  }
}
