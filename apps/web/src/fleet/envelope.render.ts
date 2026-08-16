import { randomUUID } from "node:crypto";

/**
 * Fleet's whole safe-error vocabulary: a reason from this union is everything
 * an error response says. Paths, environment values, stack traces, and raw
 * supervisor output are never present — the same stance as the telemetry
 * stream's WarningReason, kept separate because the vocabularies evolve with
 * different features.
 */
export type FleetWarningReason =
  | "CONFIG_UNPARSEABLE"
  | "SUPERVISOR_UNREADABLE"
  | "PROJECT_KEY_INVALID"
  | "PROJECT_UNKNOWN"
  | "PROJECT_DISABLED"
  | "ACTION_INVALID"
  | "ACTION_FAILED"
  | "DEFINITION_MISSING"
  | "ORIGIN_FORBIDDEN"
  | "GITHUB_UNCONFIGURED"
  | "GITHUB_UNREADABLE";

export interface FleetWarning {
  readonly reason: FleetWarningReason;
}

/**
 * Same versioned v1 shape as the stream envelope
 * (telemetry/stream-envelope.interface.ts) so console clients parse one
 * frame everywhere. `warnings` is always present: poll clients branch on
 * `warnings.length`, so absence would be a second empty-state to handle.
 */
export interface FleetEnvelope<T> {
  readonly api_version: "v1";
  /** RFC 3339 timestamp. */
  readonly emitted_at: string;
  readonly stream_id: string;
  /** Poll responses carry their position in `data`, not here. */
  readonly cursor: string;
  readonly data: T;
  readonly warnings: readonly FleetWarning[];
}

export function fleetEnvelope<T>(data: T, warnings: readonly FleetWarning[]): FleetEnvelope<T> {
  return {
    api_version: "v1",
    emitted_at: new Date().toISOString(),
    stream_id: randomUUID(),
    cursor: "",
    data,
    warnings,
  };
}
