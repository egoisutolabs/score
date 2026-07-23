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
