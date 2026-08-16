/**
 * Pure naming/cardinality/redaction/truncation decisions. Every validity
 * check rejects, never mutates — an invalid record is dropped whole, so a
 * stored line is always a line the policy accepted. The one sanctioned
 * mutation is boundBody, which cuts the free-detail field at its byte
 * ceiling AFTER the gate accepted the record — gate first, truncate second,
 * so redaction always sees the full body.
 */

import type { TelemetryAttributes, TelemetryRecord } from "./telemetry.interface";
import { METRIC_LABELS, TELEMETRY_VERSION } from "./telemetry.interface";

/** OTel-shaped dotted names under our namespace: `score.<segment>.<segment>…` */
const RECORD_NAME = /^score(\.[a-z][a-z0-9_]*)+$/;

/** RFC 3339 date-time shape; component ranges are checked in isRfc3339. */
const RFC3339_TS =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

function isRfc3339(ts: string): boolean {
  const match = RFC3339_TS.exec(ts);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (Number(month) < 1 || Number(month) > 12) return false;
  // Date.UTC(y, m, 0) is the last day of month m — leap years included.
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(day) < 1 || Number(day) > daysInMonth) return false;
  // Second 60 rejected: our producers never emit leap seconds, and RFC 3339
  // only admits :60 at an actual leap-second instant we won't validate.
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  return offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
}

const SIGNALS = new Set(["event", "span", "metric"]);

/** The declared attribute/label carriers are plain objects — not null, not arrays. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redaction table — the accompanying test table IS the spec. Exactly these
 * shapes; ceiling: no entropy scanning, no ML detection. New shapes are
 * future additive changes.
 */
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key IDs
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub classic PATs
  /\bgithub_pat_/, // GitHub fine-grained PATs
  /\bsk-[A-Za-z0-9]{20,}\b/, // API secret keys
  // Authorization header values; /i because HTTP auth schemes are
  // case-insensitive ("bearer ey..." is the same credential)
  /\bBearer\s+\S+/i,
  // env/query-shaped assignment pairs; explicit [^A-Za-z] (never a folded
  // [^a-z], /i case-folds negated classes) so api_key=/KEY= match but monkey= doesn't
  /(^|[^A-Za-z])(key|token|password|secret)=\S+/i,
  // camelCase pairs: an uppercase-initial keyword is its own word (MyToken=,
  // APIKey=). Ceiling: an all-caps run (APIKEY=) is lexically a DONKEY= and passes.
  /(Key|Token|Password|Secret)=\S+/,
];

/**
 * Keys whose final segment names a credential — bare ("token"), dotted
 * ("auth.token"), or suffixed ("api_key") — hold categorically secret
 * values regardless of shape. Final-segment only: "token_count" is a count.
 */
const SECRET_KEY_NAME = /(^|[._])(token|key|secret|password)$/i;

/** Attributes are dimensions, not payloads — free detail belongs in body, behind its own ceiling. */
export const MAX_ATTRIBUTE_VALUE_LENGTH = 256;

/** Bounded body ceiling — bytes, not characters; no compression, no overflow side-files. */
export const MAX_BODY_BYTES = 4096;

export function isValidTelemetryName(name: string): boolean {
  return RECORD_NAME.test(name);
}

/**
 * Truncates a body at MAX_BODY_BYTES and marks the cut. The cut backs off
 * past UTF-8 continuation bytes so it never tears a code point. Runs after
 * recordViolations accepted the record, never before — truncation can tear
 * a secret shape the gate would otherwise catch.
 */
export function boundBody(body: string): { body: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= MAX_BODY_BYTES) return { body, truncated: false };
  let end = MAX_BODY_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { body: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

export function attributeViolations(attributes: TelemetryAttributes): string[] {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (SECRET_KEY_NAME.test(key)) violations.push(`secret-named attribute "${key}"`);
    if (typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        // JSON.stringify would store NaN/Infinity as null, outside the declared contract.
        violations.push(`non-finite value for attribute "${key}"`);
      continue;
    }
    if (typeof value !== "string") {
      // Untyped producers can nest objects — a credential inside one would
      // ride straight past the string-shape scan below.
      violations.push(`non-scalar value for attribute "${key}"`);
      continue;
    }
    if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH)
      violations.push(`attribute "${key}" exceeds ${MAX_ATTRIBUTE_VALUE_LENGTH} chars`);
    if (SECRET_VALUE_SHAPES.some((shape) => shape.test(value)))
      violations.push(`secret-shaped value for attribute "${key}"`);
  }
  return violations;
}

/**
 * Labels are members of the enums declared in METRIC_LABELS — nothing else.
 * Enum membership is what keeps identity, paths, SHAs, and free strings out
 * of metrics; no shape heuristics needed.
 */
export function metricLabelViolations(
  labels: Readonly<Record<string, string | undefined>>,
): string[] {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined) continue;
    const members: readonly string[] | undefined = METRIC_LABELS[key as keyof typeof METRIC_LABELS];
    if (members === undefined) violations.push(`undeclared metric label "${key}"`);
    else if (!members.includes(value))
      violations.push(`value "${value}" is not a declared member of metric label "${key}"`);
  }
  return violations;
}

/** The append gate: version, timestamp, naming, bounds, redaction — reject, don't mutate. */
export function recordViolations(record: TelemetryRecord): string[] {
  // A JSONL line can parse to null, an array, or a scalar — one malformed
  // record to reject, never a TypeError that aborts the validating caller.
  if (!isPlainObject(record)) return ["record must be an object"];
  const violations: string[] = [];
  if (record.v !== TELEMETRY_VERSION) violations.push(`unknown version ${String(record.v)}`);
  if (!isRfc3339(record.ts ?? ""))
    violations.push(`ts is not an RFC 3339 timestamp: "${String(record.ts)}"`);
  if (!SIGNALS.has(record.signal)) violations.push(`unknown signal "${String(record.signal)}"`);
  if (!isValidTelemetryName(record.name)) violations.push(`invalid name "${record.name}"`);
  if (typeof record.project !== "string" || record.project === "")
    violations.push("missing or non-string project");
  // The gate runs on the record as produced — body length is NOT a violation
  // here, because the full body must be scanned before boundBody truncates
  // for storage: a credential torn at the byte ceiling no longer matches its
  // shape, so a truncate-first order would store 35/36 chars of a secret.
  const body = record.body as unknown;
  if (body !== undefined) {
    if (typeof body !== "string")
      // RegExp.test would coerce an object to "[object Object]" and scan that,
      // letting a nested credential ride through the redaction gate.
      violations.push("body must be a string");
    else if (SECRET_VALUE_SHAPES.some((shape) => shape.test(body)))
      violations.push("secret-shaped value in body");
  }
  if (record.truncated !== undefined && typeof record.truncated !== "boolean")
    violations.push("truncated must be a boolean");
  // The gate also runs on parsed, untrusted JSON in #77 — any non-object
  // shape here is malformed input to reject, never a crash or a silent pass
  // (Object.entries(null) throws; on a string/number/array it walks junk).
  const attributes = record.attributes as unknown;
  if (attributes !== undefined) {
    if (!isPlainObject(attributes)) violations.push("attributes must be an object");
    else violations.push(...attributeViolations(attributes as TelemetryAttributes));
  }
  // Subject strings pass through untouched (identity is dispatch's), but the
  // numbers must survive JSON — NaN/Infinity would serialize as null.
  if (record.subject?.issue_number !== undefined && !Number.isFinite(record.subject.issue_number))
    violations.push("non-finite subject issue_number");
  if (
    record.subject?.pull_request_number !== undefined &&
    !Number.isFinite(record.subject.pull_request_number)
  )
    violations.push("non-finite subject pull_request_number");
  if (record.signal === "span") {
    // Untrusted JSON can carry null or a number where the type says string.
    if (typeof record.span_id !== "string" || record.span_id === "")
      violations.push("span_id must be a non-empty string");
    if (
      record.parent_span_id !== undefined &&
      (typeof record.parent_span_id !== "string" || record.parent_span_id === "")
    )
      violations.push(
        "parent_span_id must be a non-empty string — omit it when there is no parent",
      );
    if (
      record.duration_ms !== undefined &&
      (!Number.isFinite(record.duration_ms) || record.duration_ms < 0)
    )
      violations.push("duration_ms must be a finite non-negative number");
    if (record.status !== undefined && record.status !== "ok" && record.status !== "error")
      violations.push('status must be "ok" or "error"');
  }
  if (record.signal === "metric") {
    if (attributes !== undefined)
      // Locked decision: identity lives in events, never metrics — attributes
      // on a metric would smuggle unbounded series past the label enums.
      violations.push("metric records carry labels, not attributes");
    if (!Number.isFinite(record.value))
      // JSON.stringify would store NaN/Infinity as null, outside the declared contract.
      violations.push("non-finite metric value");
    const labels = record.labels as unknown;
    if (labels !== undefined) {
      if (!isPlainObject(labels)) violations.push("labels must be an object");
      else violations.push(...metricLabelViolations(labels as Readonly<Record<string, string>>));
    }
  }
  return violations;
}
