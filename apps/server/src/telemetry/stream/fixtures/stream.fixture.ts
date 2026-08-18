/**
 * Fixtures for the stream tests: a sandbox projects dir seeded the way the
 * daemon lays files down, one dry-run tick's correlated records in the exact
 * order PassTelemetry appends them (#79), matching dated prose-log lines,
 * fixed-clock/fixed-id StreamDeps, and an SSE frame parser for golden
 * transcript assertions.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TelemetryRecord } from "@score/core/telemetry/telemetry.interface";
import type { StreamEnvelope } from "../../stream-envelope.interface";
import { TailerRegistry } from "../follow/tailer.service";
import type { StreamDeps } from "../stream.service";

export const TODAY = "2026-08-15";
export const NOW = `${TODAY}T12:00:00.000Z`;
export const STREAM_ID = "stream-fixed";

const sandboxes: string[] = [];

/** A fresh projects dir; call cleanupSandboxes() from afterEach. */
export function newProjectsDir(): string {
  const path = mkdtempSync(join(tmpdir(), "score-stream-"));
  sandboxes.push(path);
  return path;
}

export function cleanupSandboxes(): void {
  for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
}

/** Writes projectsDir/<key>/<relative>, creating parents. */
export function seed(projectsDir: string, key: string, relative: string, text: string): void {
  const path = join(projectsDir, key, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function seedRecords(
  projectsDir: string,
  key: string,
  segment: string,
  records: readonly object[],
): void {
  seed(
    projectsDir,
    key,
    `telemetry/${segment}.jsonl`,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
}

/** A healthy heartbeat for the fixed clock: written 30s ago by pid 4242. */
export function freshStatus(): string {
  return JSON.stringify({
    state: "running",
    pid: 4242,
    tick: 7,
    last_pass_started_at: `${TODAY}T11:59:00.000Z`,
    last_pass_completed_at: `${TODAY}T11:59:20.000Z`,
    last_error: null,
    last_gate_failure: null,
    updated_at: `${TODAY}T11:59:30.000Z`,
  });
}

export function seedResolved(projectsDir: string, key: string): void {
  // Only the allowlisted view matters; the daemon's full resolved.json also
  // carries paths, which snapshots must never emit.
  seed(
    projectsDir,
    key,
    "resolved.json",
    JSON.stringify({
      key,
      agent: { harness: "claude", model: "opus" },
      tickIntervalMs: 60_000,
      maxParallel: 2,
    }),
  );
}

export const TRACE_ID = "aaaa1111bbbb2222";
const DISPATCH_SPAN = "dddd0001";
const LANDING_SPAN = "eeee0002";
const TICK_SPAN = "ffff0003";

/**
 * One dry-run tick, appended in PassTelemetry's order: each phase's decision
 * events, then its phase span, then the tick's root span last.
 */
export function dryRunTickRecords(project: string): readonly TelemetryRecord[] {
  return [
    {
      v: 1,
      ts: `${TODAY}T11:59:01.000Z`,
      project,
      signal: "event",
      name: "score.dispatch.decision",
      subject: { issue_number: 40 },
      attributes: {
        decision: "started",
        dry_run: true,
        trace_id: TRACE_ID,
        span_id: DISPATCH_SPAN,
      },
    },
    {
      v: 1,
      ts: `${TODAY}T11:59:02.000Z`,
      project,
      signal: "span",
      name: "score.phase",
      span_id: DISPATCH_SPAN,
      parent_span_id: TICK_SPAN,
      duration_ms: 900,
      status: "ok",
      attributes: { trace_id: TRACE_ID, phase: "dispatch", dry_run: true },
    },
    {
      v: 1,
      ts: `${TODAY}T11:59:10.000Z`,
      project,
      signal: "event",
      name: "score.landing.decision",
      subject: { pull_request_number: 41 },
      attributes: { tag: "would-merge", dry_run: true, trace_id: TRACE_ID, span_id: LANDING_SPAN },
    },
    {
      v: 1,
      ts: `${TODAY}T11:59:11.000Z`,
      project,
      signal: "span",
      name: "score.phase",
      span_id: LANDING_SPAN,
      parent_span_id: TICK_SPAN,
      duration_ms: 800,
      status: "ok",
      attributes: { trace_id: TRACE_ID, phase: "landing", dry_run: true },
    },
    {
      v: 1,
      ts: `${TODAY}T11:59:20.000Z`,
      project,
      signal: "span",
      name: "score.tick",
      span_id: TICK_SPAN,
      duration_ms: 19_000,
      status: "ok",
      attributes: { trace_id: TRACE_ID, tick: 7, dry_run: true },
    },
  ];
}

export function logLine(ts: string, level: string, text: string): string {
  return `[${ts}] [${level}] ${text}\n`;
}

export function testDeps(projectsDir: string, overrides: Partial<StreamDeps> = {}): StreamDeps {
  return {
    projectsDir,
    readConfig: async () => ({
      version: 1,
      projects: {
        score: {
          enabled: true,
          main_location: "main",
          worktree_location: "worktrees",
          github_repo: "example/score",
          config: { agent: { harness: "claude" } },
        },
      },
    }),
    jobs: async () => [{ key: "score", loaded: true, pid: 4242 }],
    now: () => new Date(NOW),
    streamId: () => STREAM_ID,
    tailers: new TailerRegistry(),
    ...overrides,
  };
}

export interface ParsedFrame {
  readonly id: string | undefined;
  readonly event: string;
  readonly envelope: StreamEnvelope<unknown>;
}

/** Splits an SSE body into frames; throws on anything not frame-shaped. */
export function parseFrames(text: string): readonly ParsedFrame[] {
  if (text === "") return [];
  if (!text.endsWith("\n\n")) throw new Error(`unterminated SSE body: ${JSON.stringify(text)}`);
  return text
    .slice(0, -2)
    .split("\n\n")
    .map((frame) => {
      const match = /^(?:id: (.*)\n)?event: (.*)\ndata: (.*)$/.exec(frame);
      if (match === null) throw new Error(`malformed frame: ${JSON.stringify(frame)}`);
      return {
        id: match[1],
        event: match[2] as string,
        envelope: JSON.parse(match[3] as string) as StreamEnvelope<unknown>,
      };
    });
}

export async function drain(frames: () => AsyncGenerator<string>): Promise<readonly ParsedFrame[]> {
  const chunks: string[] = [];
  for await (const chunk of frames()) chunks.push(chunk);
  return parseFrames(chunks.join(""));
}
