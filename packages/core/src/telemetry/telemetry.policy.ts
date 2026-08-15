/**
 * Pure naming/cardinality/redaction decisions. Every check rejects, never
 * mutates: an invalid record is dropped whole, so a stored line is always a
 * line the policy accepted.
 */

import type { TelemetryAttributes, TelemetryRecord } from "./telemetry.interface";
import { TELEMETRY_VERSION } from "./telemetry.interface";

/** OTel-shaped dotted names under our namespace: `score.<segment>.<segment>…` */
const RECORD_NAME = /^score(\.[a-z][a-z0-9_]*)+$/;

/** Attribute/label keys: dotted lowercase, OTel attribute style. */
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Metric labels must stay low-cardinality (locked decision: identity lives
 * in events, never metrics). The charset kills paths and free text, the
 * hex-run check kills SHAs, and the digit-after-dash check kills numbered
 * subject identities without spelling any identity shape here.
 */
const LABEL_VALUE_CHARSET = /^[a-z0-9_.-]+$/;
const HEX_RUN = /[0-9a-f]{7}/;
const NUMBERED_IDENTITY = /-\d/;
const MAX_LABEL_VALUE_LENGTH = 32;

/**
 * Redaction: attribute values that look like credentials, env assignments,
 * or key material never reach a stored line. Deliberately no bare long-hex
 * rule — a 40-hex commit SHA is legitimate event identity.
 */
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /^(gh[pousr]|github_pat)_/, // GitHub tokens
  /^sk-/, // API secret keys
  /^xox[a-z]-/, // Slack tokens
  /^AKIA[0-9A-Z]{16}$/, // AWS access key IDs
  /^Bearer\s/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[A-Z][A-Z0-9_]*=/, // env-shaped NAME=value
];

/** Keys whose values are categorically prompts, secrets, or payloads. */
const SECRET_KEY_SEGMENT =
  /(^|[._])(token|secret|password|passwd|apikey|api_key|auth|authorization|cookie|credential|env|environment|prompt|payload)([._]|$)/;

/** Bounds "arbitrary payload" smuggling through an innocent key. */
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;

export function isValidTelemetryName(name: string): boolean {
  return RECORD_NAME.test(name);
}

export function isValidMetricLabelKey(key: string): boolean {
  return KEY.test(key);
}

export function isValidMetricLabelValue(value: string): boolean {
  return (
    value.length <= MAX_LABEL_VALUE_LENGTH &&
    LABEL_VALUE_CHARSET.test(value) &&
    !HEX_RUN.test(value) &&
    !NUMBERED_IDENTITY.test(value)
  );
}

export function metricLabelViolations(labels: Readonly<Record<string, string>>): string[] {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (!isValidMetricLabelKey(key)) violations.push(`invalid metric label key "${key}"`);
    if (!isValidMetricLabelValue(value))
      violations.push(`high-cardinality metric label value for "${key}"`);
  }
  return violations;
}

export function attributeViolations(attributes: TelemetryAttributes): string[] {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (!KEY.test(key)) violations.push(`invalid attribute key "${key}"`);
    if (SECRET_KEY_SEGMENT.test(key)) violations.push(`redacted attribute key "${key}"`);
    if (typeof value !== "string") continue;
    if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH)
      violations.push(`attribute "${key}" exceeds ${MAX_ATTRIBUTE_VALUE_LENGTH} chars`);
    if (SECRET_VALUE_SHAPES.some((shape) => shape.test(value)))
      violations.push(`secret-shaped value for attribute "${key}"`);
  }
  return violations;
}

/** The append gate: names, version, redaction — reject, don't mutate. */
export function recordViolations(record: TelemetryRecord): string[] {
  const violations: string[] = [];
  if (record.version !== TELEMETRY_VERSION)
    violations.push(`unknown version ${String(record.version)}`);
  if (!isValidTelemetryName(record.name)) violations.push(`invalid name "${record.name}"`);
  if (record.kind !== "event" && record.kind !== "span")
    violations.push(`unknown kind "${String((record as TelemetryRecord).kind)}"`);
  if (!record.time) violations.push("missing time");
  if (!record.resource?.project) violations.push("missing resource.project");
  if (record.attributes !== undefined) violations.push(...attributeViolations(record.attributes));
  return violations;
}
