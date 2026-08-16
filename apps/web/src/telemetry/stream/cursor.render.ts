/**
 * The composite cursor at rest (#81): every selected project/source's
 * segment + byte offset, base64url-encoded JSON, carried on each frame's
 * `id:` line and presented back through Last-Event-ID. Opaque to clients;
 * this module is the only place that spells the encoding.
 */

import type { TelemetryCursor } from "@score/core/telemetry/telemetry.interface";

export function encodeCursor(components: readonly TelemetryCursor[]): string {
  return Buffer.from(JSON.stringify(components)).toString("base64url");
}

/** Undefined on anything that does not decode to well-shaped components. */
export function decodeCursor(value: string): readonly TelemetryCursor[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every(isComponent)) return undefined;
  return parsed;
}

function isComponent(value: unknown): value is TelemetryCursor {
  if (typeof value !== "object" || value === null) return false;
  const component = value as Record<string, unknown>;
  return (
    typeof component.project === "string" &&
    (component.source === "telemetry" || component.source === "log") &&
    typeof component.segment === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(component.segment) &&
    typeof component.byte_offset === "number" &&
    Number.isInteger(component.byte_offset) &&
    component.byte_offset >= 0
  );
}
