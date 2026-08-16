import type { StatusFile } from "@score/core/daemon/status.service";
import type { Dot } from "./dot.policy";
import type { ProjectView, ResolvedView } from "./snapshot.service";

/** The wire shape of one fleet row: ProjectView with the JobStatus union
 * flattened — an uninstalled job (undefined) reads as not loaded with no
 * pid, the same row the TUI showed gray. */
export interface ProjectViewJson {
  readonly key: string;
  readonly enabled: boolean;
  readonly dot: Dot;
  readonly pid: number | null;
  readonly loaded: boolean;
  readonly stopping: boolean;
  readonly status: StatusFile | null;
  readonly resolved: ResolvedView | null;
}

export function projectViewJson(view: ProjectView): ProjectViewJson {
  return {
    key: view.key,
    enabled: view.enabled,
    dot: view.dot,
    pid: view.job?.pid ?? null,
    loaded: view.job?.loaded === true,
    stopping: view.job?.stopping === true,
    status: view.status,
    resolved: view.resolved,
  };
}
