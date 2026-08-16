/**
 * Pure naming/cardinality/redaction/truncation decisions. Every validity
 * check rejects, never mutates — an invalid record is dropped whole, so a
 * stored line is always a line the policy accepted. The one sanctioned
 * mutation is boundBody, which cuts the free-detail field at its byte
 * ceiling before validation.
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
  // Second 60 stays valid: RFC 3339 admits leap seconds.
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return false;
  return offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
}

const SIGNALS = new Set(["event", "span", "metric"]);

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
  /\bBearer\s+\S+/, // Authorization header values
  // env/query-shaped assignment pairs; [^a-z] (not \b) so api_key= matches but monkey= doesn't
  /(^|[^a-z])(key|token|password|secret)=\S+/i,
];

/** Keys whose values are categorically secrets regardless of shape. */
const SECRET_KEY_NAME = /_(token|key|secret|password)$/i;

/** Bounded body ceiling — bytes, not characters; no compression, no overflow side-files. */
export const MAX_BODY_BYTES = 4096;

export function isValidTelemetryName(name: string): boolean {
  return RECORD_NAME.test(name);
}

/**
 * Truncates a body at MAX_BODY_BYTES and marks the cut. The cut backs off
 * past UTF-8 continuation bytes so it never tears a code point.
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
    if (typeof value === "number" && !Number.isFinite(value))
      // JSON.stringify would store NaN/Infinity as null, outside the declared contract.
      violations.push(`non-finite value for attribute "${key}"`);
    if (typeof value === "string" && SECRET_VALUE_SHAPES.some((shape) => shape.test(value)))
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
  const violations: string[] = [];
  if (record.v !== TELEMETRY_VERSION) violations.push(`unknown version ${String(record.v)}`);
  if (!isRfc3339(record.ts ?? ""))
    violations.push(`ts is not an RFC 3339 timestamp: "${String(record.ts)}"`);
  if (!SIGNALS.has(record.signal)) violations.push(`unknown signal "${String(record.signal)}"`);
  if (!isValidTelemetryName(record.name)) violations.push(`invalid name "${record.name}"`);
  if (!record.project) violations.push("missing project");
  if (record.body !== undefined && new TextEncoder().encode(record.body).length > MAX_BODY_BYTES)
    // boundBody owns truncation; a body past the ceiling means it was skipped.
    violations.push(`body exceeds ${MAX_BODY_BYTES} bytes; apply boundBody first`);
  if (record.attributes !== undefined) violations.push(...attributeViolations(record.attributes));
  if (record.signal === "metric" && record.labels !== undefined)
    violations.push(...metricLabelViolations(record.labels));
  return violations;
}
