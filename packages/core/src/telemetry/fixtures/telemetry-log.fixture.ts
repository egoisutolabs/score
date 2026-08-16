// Fixtures for the telemetry-log tests: a valid v1 record builder, raw
// segment seeding (torn fragments and foreign lines are laid down as bytes,
// exactly how a reader meets them), and a settable UTC clock.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TelemetryEvent } from "@score/core/telemetry/telemetry.interface";

export const project = "demo";

export function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    v: 1,
    ts: "2026-08-15T12:00:00Z",
    signal: "event",
    name: "score.dispatch.blocked",
    project,
    ...overrides,
  };
}

export function line(record: object): string {
  return `${JSON.stringify(record)}\n`;
}

/** Lays down a segment file byte-for-byte — content is raw, not records. */
export function seedSegment(dir: string, date: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${date}.jsonl`), content);
}

export interface TestClock {
  now: () => Date;
  set: (iso: string) => void;
}

export function clock(iso: string): TestClock {
  let current = new Date(iso);
  return {
    now: () => current,
    set: (next) => {
      current = new Date(next);
    },
  };
}
