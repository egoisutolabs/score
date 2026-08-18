import type { JobStatus } from "@score/core/supervisor/supervisor-adapter.interface";
import type { Dot } from "./dots";

/** The resolved project values rendered by the TUI's config pane. */
export interface ResolvedView {
  readonly agent: string;
  readonly tickIntervalMs: number;
  readonly maxParallel: number;
}

/** One project snapshot after the server wire shape is adapted for rendering. */
export interface ProjectView {
  readonly key: string;
  readonly enabled: boolean;
  readonly job: JobStatus | undefined;
  readonly status: { readonly tick: number | null } | null;
  readonly resolved: ResolvedView | null;
  readonly dot: Dot;
}

export interface TuiPoll {
  readonly projects: readonly ProjectView[];
  readonly logs: ReadonlyMap<string, readonly string[]>;
  readonly logFile: string;
  readonly warnings: readonly string[];
}

/** Read-only data seam; lifecycle actions deliberately remain supervisor-owned. */
export interface TuiDataSource {
  poll(): Promise<TuiPoll>;
}
