import { randomBytes } from "node:crypto";
import type { LandingResult } from "@score/core/landing/change.interface";
import type { MaintenanceTickResult } from "@score/core/maintenance/maintenance.service";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import type { TelemetryResource } from "@score/core/telemetry/telemetry.interface";
import { TelemetryLogService } from "@score/core/telemetry/telemetry-log.service";
import { telemetryDir } from "@score/shared/config/layout";
import type { Logger } from "@score/shared/log";
import type {
  PhaseOutcome,
  PhaseTrace,
  TelemetryEnv,
  TickOutcome,
  TickTrace,
} from "./telemetry.render";
import {
  landingDecisionEvents,
  maintenanceDecisionEvents,
  phaseSpanRecord,
  repairDecisionEvents,
  tickSpanRecord,
} from "./telemetry.render";

/**
 * OTel-shaped correlation identity. Lives with the stateful service, not the
 * pure render module: minting ids is a side effect, and the recorder is the
 * only thing that needs fresh ones.
 */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Correlation ids of the span active right now. The telemetry writer's
 * rate-limited failure prose reads this box so a new log line emitted inside
 * a span carries the span's trace_id/span_id (epic #58: correlated logs).
 */
export interface SpanCorrelation {
  trace_id?: string;
  span_id?: string;
}

/**
 * The telemetry face the daemon loop talks to. Undefined (unmanaged discovery
 * mode, no project key) records nothing; phases never see it — only the
 * composition in daemon.run.ts and its phase wrappers call it with results the
 * phases already returned. Every append is a complete single record: telemetry
 * is never a transaction boundary and a pass never waits on a commit.
 */
export interface TickTelemetry {
  beginTick(tickNumber: number): void;
  beginPhase(name: string): void;
  maintenanceDecisions(result: MaintenanceTickResult): void;
  landingDecisions(results: readonly LandingResult[]): void;
  repairDecisions(results: readonly RepairResult[]): void;
  /** Marks the phase span's outcome "suppressed" — the landing-skipped guard. */
  phaseSuppressed(): void;
  phaseFailed(error: unknown): void;
  endPhase(): void;
  endTick(passError: string | null): void;
}

export interface TickTelemetryServiceOptions {
  /**
   * Performs the retention sweep; may throw. The service reports the failure
   * and leaves the day unswept, so the next tick retries — an operator
   * restoring directory permissions later the same day is recovered without
   * a restart.
   */
  readonly sweep?: () => void;
  /** Wall clock for record timestamps; never used for durations. */
  readonly now?: () => Date;
  /**
   * Monotonic clock for span durations. Wall-clock subtraction would emit
   * negative or inflated duration_ms under an NTP step mid-tick.
   */
  readonly mono?: () => number;
  /** Telemetry-failure reports (a failed sweep, a disabled recorder). */
  readonly onError?: (message: string) => void;
}

/**
 * Holds the open tick/phase spans of the pass in flight and appends each
 * closed span and each mapped decision as one complete record. End methods
 * are idempotent no-ops without a matching begin, so a wrapper's finally can
 * call them on every exit path. A telemetry-side failure (ids, clock, sweep)
 * disables the recorder for the rest of the process and reports once —
 * instrumentation is never authoritative over a phase or a pass (locked
 * decision 9), so no method here may throw.
 */
export class TickTelemetryService implements TickTelemetry {
  readonly #writer: TelemetryLogService;
  readonly #env: TelemetryEnv;
  readonly #correlation: SpanCorrelation;
  readonly #now: () => Date;
  readonly #mono: () => number;
  readonly #sweep?: () => void;
  readonly #onError?: (message: string) => void;
  // Retention mirrors the prose log's rule (file-log.ts): sweep at startup
  // and again whenever a later tick observes a new UTC date — a supervised
  // daemon runs for weeks, and a startup-only sweep would stop pruning after
  // its first day. The date is recorded only after a successful sweep.
  #sweptDate: string | undefined;
  #sweepWarnDate: string | undefined;
  #disabled = false;
  #tick: TickTrace | undefined;
  #tickOpenedAt = 0;
  #phase: PhaseTrace | undefined;
  #phaseOpenedAt = 0;
  #phaseErrorType: string | undefined;
  #phaseSuppressed = false;

  constructor(
    writer: TelemetryLogService,
    resource: TelemetryResource,
    dryRun: boolean,
    correlation: SpanCorrelation,
    options: TickTelemetryServiceOptions = {},
  ) {
    this.#writer = writer;
    this.#env = { resource, dry_run: dryRun };
    this.#correlation = correlation;
    this.#now = options.now ?? (() => new Date());
    this.#mono = options.mono ?? (() => performance.now());
    this.#sweep = options.sweep;
    this.#onError = options.onError;
    this.#guarded(() => this.#sweepOnRollover());
  }

  beginTick(tickNumber: number): void {
    this.#guarded(() => {
      this.#sweepOnRollover();
      this.#tick = { trace_id: newTraceId(), span_id: newSpanId(), tick_number: tickNumber };
      this.#tickOpenedAt = this.#mono();
      this.#correlation.trace_id = this.#tick.trace_id;
      this.#correlation.span_id = this.#tick.span_id;
    });
  }

  beginPhase(name: string): void {
    this.#guarded(() => {
      if (this.#tick === undefined) return;
      this.#phase = {
        trace_id: this.#tick.trace_id,
        span_id: newSpanId(),
        tick_number: this.#tick.tick_number,
        phase: name,
        parent_span_id: this.#tick.span_id,
      };
      this.#phaseOpenedAt = this.#mono();
      this.#phaseErrorType = undefined;
      this.#phaseSuppressed = false;
      this.#correlation.span_id = this.#phase.span_id;
    });
  }

  maintenanceDecisions(result: MaintenanceTickResult): void {
    this.#guarded(() => {
      if (this.#phase === undefined) return;
      for (const record of maintenanceDecisionEvents(result, this.#phase, this.#env, this.#time()))
        this.#writer.append(record);
    });
  }

  landingDecisions(results: readonly LandingResult[]): void {
    this.#guarded(() => {
      if (this.#phase === undefined) return;
      for (const record of landingDecisionEvents(results, this.#phase, this.#env, this.#time()))
        this.#writer.append(record);
    });
  }

  repairDecisions(results: readonly RepairResult[]): void {
    this.#guarded(() => {
      if (this.#phase === undefined) return;
      for (const record of repairDecisionEvents(results, this.#phase, this.#env, this.#time()))
        this.#writer.append(record);
    });
  }

  phaseSuppressed(): void {
    this.#phaseSuppressed = true;
  }

  phaseFailed(error: unknown): void {
    // The exception's type only — messages are free text and stay in prose.
    this.#phaseErrorType = error instanceof Error ? error.name : "non-error";
  }

  endPhase(): void {
    this.#guarded(() => {
      if (this.#tick === undefined || this.#phase === undefined) return;
      const openedAt = this.#phaseOpenedAt;
      this.#appendPhase(openedAt);
      this.#correlation.span_id = this.#tick.span_id;
      this.#phase = undefined;
    });
  }

  endTick(passError: string | null): void {
    this.#guarded(() => {
      if (this.#tick === undefined) return;
      const openedAt = this.#tickOpenedAt;
      const outcome: TickOutcome = passError === null ? "ok" : "error";
      this.#writer.append(
        tickSpanRecord({
          trace: this.#tick,
          env: this.#env,
          started_at: openedAt,
          ended_at: this.#mono(),
          time: this.#time(),
          outcome,
        }),
      );
      this.#correlation.trace_id = undefined;
      this.#correlation.span_id = undefined;
      this.#tick = undefined;
    });
  }

  #appendPhase(openedAt: number): void {
    const phase = this.#phase as PhaseTrace;
    const outcome: PhaseOutcome =
      this.#phaseSuppressed === true
        ? "suppressed"
        : this.#phaseErrorType === undefined
          ? "ok"
          : "error";
    this.#writer.append(
      phaseSpanRecord({
        trace: phase,
        env: this.#env,
        started_at: openedAt,
        ended_at: this.#mono(),
        time: this.#time(),
        outcome,
        ...(this.#phaseErrorType !== undefined && { error_type: this.#phaseErrorType }),
      }),
    );
  }

  #time(): string {
    return this.#now().toISOString();
  }

  #sweepOnRollover(): void {
    if (this.#sweep === undefined) return;
    const today = this.#now().toISOString().slice(0, 10);
    if (today === this.#sweptDate) return;
    try {
      // The failure is contained here, on purpose: a retention hiccup
      // (ENOENT from a racing external cleanup, a transient EACCES) must
      // never reach #guarded's kill-switch — that would silence the whole
      // correlated trace over a sweep that has nothing to do with recording.
      this.#sweep();
      // Only a successful sweep marks the day — a failure leaves it unswept
      // so the next tick retries.
      this.#sweptDate = today;
    } catch (error) {
      // Reported at most once per UTC day: a broken sweep retries every tick
      // until it heals, and per-tick warns would bury the signal.
      if (today === this.#sweepWarnDate) return;
      this.#sweepWarnDate = today;
      this.#onError?.(
        `telemetry retention sweep failed (retried next tick): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Telemetry must never suppress daemon work: any internal failure disables
   * the recorder (silently for the caller, loudly via onError) instead of
   * escaping into a phase or the pass loop.
   */
  #guarded(step: () => void): void {
    if (this.#disabled) return;
    try {
      step();
    } catch (error) {
      this.#disabled = true;
      this.#correlation.trace_id = undefined;
      this.#correlation.span_id = undefined;
      this.#onError?.(
        `telemetry disabled after a failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * The production recorder for a resolved project: segments under the
 * project's telemetry dir, retention under the prose log's window, failures
 * reported as rate-limited warns stamped with the active span.
 */
export function projectTelemetry(
  project: string,
  dryRun: boolean,
  logRetentionDays: number | undefined,
  log: Logger,
  correlation: SpanCorrelation,
): TickTelemetry {
  const resource: TelemetryResource = { project, daemon_pid: process.pid };
  // The writer's failure report is the one new prose line; stamp it with the
  // active span when it fires mid-pass. A throwing reporter stays the
  // writer's problem (it swallows that itself) — never a phase's.
  const report = (message: string) =>
    log.warn(
      correlation.trace_id === undefined
        ? message
        : `${message} (trace_id=${correlation.trace_id} span_id=${correlation.span_id})`,
    );
  const writer = new TelemetryLogService(telemetryDir(project), resource, undefined, report);
  return new TickTelemetryService(writer, resource, dryRun, correlation, {
    // Telemetry keeps the prose log's retention window — no knob of its own.
    // The service owns failure isolation: a failed sweep reports through the
    // same warn path and retries next tick instead of throwing into one
    // (locked decision 9).
    ...(logRetentionDays !== undefined && { sweep: () => writer.sweepRetention(logRetentionDays) }),
    onError: report,
  });
}
