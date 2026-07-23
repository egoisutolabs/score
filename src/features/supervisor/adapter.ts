import type { ResolvedProject } from "@/features/config/model";
import { LaunchdSupervisor } from "@/features/supervisor/launchd";
import { renderPlist } from "@/features/supervisor/plist";
import { renderUnit, SystemdSupervisor } from "@/features/supervisor/systemd";
import type { CommandRunner } from "@/shared/command-runner";

/** One score-namespace supervisor job. `loaded` distinguishes a bootstrapped
 * job from a lingering definition file with no live registration. */
export interface JobStatus {
  readonly key: string;
  readonly loaded: boolean;
  readonly pid?: number;
}

/**
 * The frozen supervisor surface: issue 8 re-implements it for systemd and
 * issue 7 drives it from the TUI. Everything OS-specific (plists, launchctl,
 * unit files) stays behind these five methods.
 */
export interface SupervisorAdapter {
  /** Write the job definition and register it with the supervisor. */
  install(key: string, definition: string): Promise<void>;
  /** Deregister the job and delete its definition; the state dir survives. */
  uninstall(key: string): Promise<void>;
  start(key: string): Promise<void>;
  /** Deregister the job but keep its definition file (restart path). */
  stop(key: string): Promise<void>;
  /** Every score-namespace job — loaded or definition-only — and nothing else. */
  status(): Promise<JobStatus[]>;
}

/** Renders one supervised daemon's job definition (plist or unit file). */
export type DefinitionRenderer = (
  project: ResolvedProject,
  invocation: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => string;

export interface PlatformSupervisor {
  readonly adapter: SupervisorAdapter;
  readonly renderDefinition: DefinitionRenderer;
}

/**
 * darwin → launchd, linux → systemd; anything else throws here, before any
 * config or filesystem mutation.
 */
export function supervisorForPlatform(
  runner: CommandRunner,
  platform: string = process.platform,
): PlatformSupervisor {
  switch (platform) {
    case "darwin":
      return { adapter: new LaunchdSupervisor(runner), renderDefinition: renderPlist };
    case "linux":
      return { adapter: new SystemdSupervisor(runner), renderDefinition: renderUnit };
    default:
      throw new Error(
        `score supervisor supports macOS (launchd) and Linux (systemd) — got ${platform}`,
      );
  }
}
