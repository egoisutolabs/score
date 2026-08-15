/**
 * The v1 telemetry vocabulary: OTel-shaped records serialized one JSON line
 * per record into dated per-project segments. v1 evolves additively only —
 * new optional fields may appear; an existing field's name, type, or meaning
 * never changes. Readers ignore unknown fields and surface an unknown record
 * version as a warning, never a crash.
 */

export const TELEMETRY_VERSION = 1;

/** Emitted by the writer after a torn-write recovery terminated a fragment. */
export const GAP_RECORD_NAME = "score.telemetry.gap";

/** What produced the records: the daemon of one project. */
export interface TelemetryResource {
  readonly project: string;
  readonly daemon_pid?: number;
}

/**
 * Who a record is about. Every string is copied verbatim from values
 * dispatch.identity.ts produced — telemetry never derives, formats, or
 * parses an identity.
 */
export interface TelemetrySubject {
  readonly session?: string;
  readonly branch?: string;
  readonly issue_number?: number;
  readonly pull_request_number?: number;
}

/** High-cardinality identity is allowed here (events), never in metric labels. */
export type TelemetryAttributes = Readonly<Record<string, string | number | boolean>>;

interface TelemetryRecordBase {
  readonly version: number;
  /** ISO 8601 UTC timestamp. */
  readonly time: string;
  /** Dotted OTel-shaped name under the `score.` namespace. */
  readonly name: string;
  readonly resource: TelemetryResource;
  readonly subject?: TelemetrySubject;
  readonly attributes?: TelemetryAttributes;
}

export interface TelemetryEvent extends TelemetryRecordBase {
  readonly kind: "event";
}

export interface TelemetrySpan extends TelemetryRecordBase {
  readonly kind: "span";
  readonly span_id: string;
  readonly parent_span_id?: string;
  readonly duration_ms?: number;
  readonly status?: "ok" | "error";
}

export type TelemetryRecord = TelemetryEvent | TelemetrySpan;

/** Distinguishes the telemetry JSONL from the existing dated human log. */
export type TelemetrySource = "telemetry" | "log";

/**
 * A file position. `segment` is the UTC date stamp (YYYY-MM-DD) of a dated
 * file; `byte_offset` always sits at the start of a line.
 */
export interface TelemetryCursor {
  readonly project: string;
  readonly source: TelemetrySource;
  readonly segment: string;
  readonly byte_offset: number;
}

/**
 * A fleet cursor is an opaque map of every selected project/source position;
 * the reader owns the key scheme, writers never interpret it.
 */
export type FleetCursor = Readonly<Record<string, TelemetryCursor>>;

/** Bounds a scan; every field narrows, an absent field matches everything. */
export interface TelemetryFilter {
  /** A record matches when its name equals a prefix or extends it dot-wise. */
  readonly names?: readonly string[];
  readonly kinds?: readonly TelemetryRecord["kind"][];
  /** Exact matches against subject strings copied from dispatch identity. */
  readonly session?: string;
  readonly branch?: string;
}

export interface TelemetryReadResult {
  /** `cursor-expired` — retention deleted the cursor's segment; never silent truncation. */
  readonly outcome: "ok" | "cursor-expired";
  readonly records: readonly TelemetryRecord[];
  /** Unknown-version and unparseable lines surface here, never as a crash. */
  readonly warnings: readonly string[];
  /** Position after the last complete line consumed; unchanged on `cursor-expired`. */
  readonly cursor: TelemetryCursor;
}
