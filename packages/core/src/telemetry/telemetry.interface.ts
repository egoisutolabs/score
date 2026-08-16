/**
 * The v1 telemetry vocabulary: OTel-shaped records every other telemetry
 * issue builds against. Within v1 the shape evolves additively only — new
 * optional fields may appear; an existing field's name, type, or meaning
 * never changes. This module is types only; decisions live in
 * telemetry.policy.ts, I/O lands in later issues (#77).
 */

export const TELEMETRY_VERSION = 1;

export type TelemetrySignal = "event" | "span" | "metric";

/** What produced the records: the daemon of one project. */
export interface TelemetryResource {
  readonly project: string;
}

/**
 * Who a record is about. Every string is copied byte-identical from values
 * dispatch.identity.ts produced — telemetry never derives, formats, or
 * parses an identity.
 */
export interface TelemetrySubject {
  readonly session?: string;
  readonly branch?: string;
  readonly issue_number?: number;
  readonly pull_request_number?: number;
}

/** High-cardinality identity is allowed here (events/spans), never in metric labels. */
export type TelemetryAttributes = Readonly<Record<string, string | number | boolean>>;

interface TelemetryRecordBase extends TelemetryResource {
  readonly v: typeof TELEMETRY_VERSION;
  /** RFC 3339 timestamp. */
  readonly ts: string;
  readonly signal: TelemetrySignal;
  /** Dotted OTel-shaped name under the `score.` namespace. */
  readonly name: string;
  readonly subject?: TelemetrySubject;
  readonly attributes?: TelemetryAttributes;
  /** Free detail, bounded to MAX_BODY_BYTES by boundBody in telemetry.policy.ts. */
  readonly body?: string;
  /** Set by boundBody when it cut the body at the byte ceiling. */
  readonly truncated?: boolean;
}

export interface TelemetryEvent extends TelemetryRecordBase {
  readonly signal: "event";
}

export interface TelemetrySpan extends TelemetryRecordBase {
  readonly signal: "span";
  /** Non-empty; the policy rejects "". */
  readonly span_id: string;
  /** Omit when there is no parent — never empty. */
  readonly parent_span_id?: string;
  readonly duration_ms?: number;
  readonly status?: "ok" | "error";
}

/**
 * The exhaustive metric-label vocabulary. Labels are enum members declared
 * here — identity (issues, PRs, sessions), paths, SHAs, and free strings
 * never become label values; new values are additive contract changes.
 */
export const METRIC_LABELS = {
  phase: ["dispatch", "repair", "landing", "cleanup", "maintenance"],
  outcome: ["ok", "error"],
} as const;

export type TelemetryMetricLabels = {
  readonly [K in keyof typeof METRIC_LABELS]?: (typeof METRIC_LABELS)[K][number];
};

export interface TelemetryMetric extends TelemetryRecordBase {
  readonly signal: "metric";
  readonly value: number;
  /** Metrics carry labels only — attributes would smuggle identity past the label enums. */
  readonly attributes?: never;
  readonly labels?: TelemetryMetricLabels;
}

export type TelemetryRecord = TelemetryEvent | TelemetrySpan | TelemetryMetric;

/** Distinguishes the telemetry stream from the existing dated human log. */
export type TelemetrySource = "telemetry" | "log";

/**
 * A file position. `segment` is the UTC date stamp (YYYY-MM-DD) of a dated
 * file. Shape only — runtime semantics land in #77.
 */
export interface TelemetryCursor {
  readonly project: string;
  readonly source: TelemetrySource;
  readonly segment: string;
  readonly byte_offset: number;
}

/** Bounds a scan; every field narrows, an absent field matches everything. */
export interface TelemetryFilter {
  /** A record matches when its name equals a listed prefix or extends it dot-wise. */
  readonly names?: readonly string[];
  readonly signals?: readonly TelemetrySignal[];
  /** Exact matches against subject strings copied from dispatch identity. */
  readonly session?: string;
  readonly branch?: string;
}
