/**
 * Snapshot payload shaping (#81): the observed fleet becomes the
 * score.snapshot.fleet and score.snapshot.project envelope bodies. Every
 * field emitted is an allowlisted copy — absolute paths (mainLocation,
 * worktreeLocation) and free error text never leave the box.
 */

import type { StatusFile } from "@score/core/daemon/status.service";
import type { Health } from "@score/core/observation/health.policy";
import type { TelemetryCursor } from "@score/core/telemetry/telemetry.interface";
import type { FleetObservation, ProjectObservation, SnapshotConfigView } from "./snapshot.service";

export interface FleetSnapshotData {
  readonly projects: readonly {
    readonly project: string;
    readonly enabled: boolean | null;
    readonly health: Health;
  }[];
}

export function fleetSnapshotData(observation: FleetObservation): FleetSnapshotData {
  return {
    projects: observation.projects.map((project) => ({
      project: project.key,
      enabled: project.enabled,
      health: project.health,
    })),
  };
}

/**
 * status.json minus last_error/last_gate_failure: their free text can embed
 * absolute paths and raw gate output, which never enter API payloads — the
 * health reasons already carry the crashed/stale verdict those fields feed.
 */
export interface SnapshotStatusView {
  readonly state: StatusFile["state"];
  readonly pid: number;
  readonly tick: number | null;
  readonly last_pass_started_at: string | null;
  readonly last_pass_completed_at: string | null;
  readonly updated_at: string;
}

export interface ProjectSnapshotData {
  readonly project: string;
  readonly enabled: boolean | null;
  readonly supervisor: { readonly loaded: boolean; readonly pid?: number } | null;
  readonly status: SnapshotStatusView | null;
  readonly config: SnapshotConfigView | null;
  readonly health: Health;
  /** The replay high-water positions captured for this project at subscribe. */
  readonly telemetry_watermark: readonly Omit<TelemetryCursor, "project">[];
}

export function projectSnapshotData(
  project: ProjectObservation,
  watermark: readonly TelemetryCursor[],
): ProjectSnapshotData {
  return {
    project: project.key,
    enabled: project.enabled,
    supervisor:
      project.job === undefined
        ? null
        : {
            loaded: project.job.loaded,
            ...(project.job.pid !== undefined && { pid: project.job.pid }),
          },
    status:
      project.status === null
        ? null
        : {
            state: project.status.state,
            pid: project.status.pid,
            tick: project.status.tick,
            last_pass_started_at: project.status.last_pass_started_at,
            last_pass_completed_at: project.status.last_pass_completed_at,
            updated_at: project.status.updated_at,
          },
    config: project.config,
    health: project.health,
    telemetry_watermark: watermark.map(({ source, segment, byte_offset }) => ({
      source,
      segment,
      byte_offset,
    })),
  };
}
