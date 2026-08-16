// The client's copy of the v1 fleet API contract. Kept as plain interfaces on
// the console side so client components never import server-only fleet code;
// the shapes must match what src/fleet serializes — reconciled by the fleet
// route tests, which assert this exact JSON.

export type Dot = "green" | "amber" | "red" | "gray";

/** The TUI's dot vocabulary, verbatim — the console keeps its muscle memory. */
export const DOT_WORD: Record<Dot, string> = {
  green: "running",
  amber: "stale",
  red: "error",
  gray: "stopped",
};

export interface StatusJson {
  readonly state: string;
  readonly pid: number;
  readonly tick: number | null;
  readonly last_pass_started_at: string | null;
  readonly last_pass_completed_at: string | null;
  readonly last_error: string | null;
  readonly last_gate_failure: string | null;
  readonly updated_at: string;
}

export interface ResolvedJson {
  readonly agent: string;
  readonly tickIntervalMs: number;
  readonly maxParallel: number;
}

export interface ProjectViewJson {
  readonly key: string;
  readonly enabled: boolean;
  readonly dot: Dot;
  readonly pid: number | null;
  readonly loaded: boolean;
  readonly stopping: boolean;
  readonly status: StatusJson | null;
  readonly resolved: ResolvedJson | null;
}

export interface FleetJson {
  readonly projects: readonly ProjectViewJson[];
}

export interface LogTailJson {
  readonly file: string;
  readonly lines: readonly string[];
  readonly cursor: string;
  readonly reset: boolean;
}

export type ProjectAction = "start" | "stop" | "restart";

/**
 * Mirror of @score/shared's default: the pulse needs a period before the
 * first resolved.json exists, and client code must not import server config
 * machinery for one number.
 */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;
