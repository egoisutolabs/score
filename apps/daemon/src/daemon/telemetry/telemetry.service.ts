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
  newSpanId,
  newTraceId,
  phaseSpanRecord,
  repairDecisionEvents,
  tickSpanRecord,
} from "./telemetry.render";

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
   * Performs the retention sweep. Provided as a callback so projectTelemetry
   * can wrap its failures into warnings; the recorder itself only decides
   * when to call it.
   */
  readonly sweep?: () => void;
  /** Tick clock; overridable so tests can drive a UTC rollover. */
  readonly now?: () => Date;
}

/**
 * Holds the open tick/phase spans of the pass in flight and appends each
 * closed span and each mapped decision as one complete record. End methods
 * are idempotent no-ops without a matching begin, so a wrapper's finally can
 * call them on every exit path.
 */
export class TickTelemetryService implements TickTelemetry {
  readonly #writer: TelemetryLogService;
  readonly #env: TelemetryEnv;
  readonly #correlation: SpanCorrelation;
  readonly #now: () => Date;
  readonly #sweep?: () => void;
  // Retention mirrors the prose log's rule (file-log.ts): sweep at startup
  // and again whenever a later tick observes a new UTC date — a supervised
  // daemon runs for weeks, and a startup-only sweep would stop pruning after
  // its first day.
  #sweptDate: string | undefined;
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
    this.#sweep = options.sweep;
    this.#sweepOnRollover();
  }

  beginTick(tickNumber: number): void {
    this.#sweepOnRollover();
    this.#tick = { trace_id: newTraceId(), span_id: newSpanId(), tick_number: tickNumber };
    this.#tickOpenedAt = this.#now().getTime();
    this.#correlation.trace_id = this.#tick.trace_id;
    this.#correlation.span_id = this.#tick.span_id;
  }

  beginPhase(name: string): void {
    if (this.#tick === undefined) return;
    this.#phase = {
      trace_id: this.#tick.trace_id,
      span_id: newSpanId(),
      tick_number: this.#tick.tick_number,
      phase: name,
      parent_span_id: this.#tick.span_id,
    };
    this.#phaseOpenedAt = this.#now().getTime();
    this.#phaseErrorType = undefined;
    this.#phaseSuppressed = false;
    this.#correlation.span_id = this.#phase.span_id;
  }

  maintenanceDecisions(result: MaintenanceTickResult): void {
    this.#decisions(maintenanceDecisionEvents(result, this.#phaseTrace(), this.#env, this.#time()));
  }

  landingDecisions(results: readonly LandingResult[]): void {
    this.#decisions(landingDecisionEvents(results, this.#phaseTrace(), this.#env, this.#time()));
  }

  repairDecisions(results: readonly RepairResult[]): void {
    this.#decisions(repairDecisionEvents(results, this.#phaseTrace(), this.#env, this.#time()));
  }

  phaseSuppressed(): void {
    this.#phaseSuppressed = true;
  }

  phaseFailed(error: unknown): void {
    // The exception's type only — messages are free text and stay in prose.
    this.#phaseErrorType = error instanceof Error ? error.name : "non-error";
  }

  endPhase(): void {
    if (this.#tick === undefined || this.#phase === undefined) return;
    const closedAt = this.#now().getTime();
    const outcome: PhaseOutcome =
      this.#phaseSuppressed === true
        ? "suppressed"
        : this.#phaseErrorType === undefined
          ? "ok"
          : "error";
    this.#writer.append(
      phaseSpanRecord({
        trace: this.#phase,
        env: this.#env,
        started_at: this.#phaseOpenedAt,
        ended_at: closedAt,
        time: new Date(closedAt).toISOString(),
        outcome,
        ...(this.#phaseErrorType !== undefined && { error_type: this.#phaseErrorType }),
      }),
    );
    this.#correlation.span_id = this.#tick.span_id;
    this.#phase = undefined;
  }

  endTick(passError: string | null): void {
    if (this.#tick === undefined) return;
    const closedAt = this.#now().getTime();
    const outcome: TickOutcome = passError === null ? "ok" : "error";
    this.#writer.append(
      tickSpanRecord({
        trace: this.#tick,
        env: this.#env,
        started_at: this.#tickOpenedAt,
        ended_at: closedAt,
        time: new Date(closedAt).toISOString(),
        outcome,
      }),
    );
    this.#correlation.trace_id = undefined;
    this.#correlation.span_id = undefined;
    this.#tick = undefined;
  }

  #decisions(records: ReturnType<typeof maintenanceDecisionEvents>): void {
    for (const record of records) this.#writer.append(record);
  }

  #phaseTrace(): PhaseTrace {
    return this.#phase as PhaseTrace;
  }

  #time(): string {
    return this.#now().toISOString();
  }

  #sweepOnRollover(): void {
    if (this.#sweep === undefined) return;
    const today = this.#now().toISOString().slice(0, 10);
    if (today === this.#sweptDate) return;
    this.#sweptDate = today;
    this.#sweep();
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
  const writer = new TelemetryLogService(telemetryDir(project), resource, undefined, (message) => {
    // The writer's failure report is the one new prose line; stamp it with
    // the active span when it fires mid-pass. A throwing reporter stays the
    // writer's problem (it swallows that itself) — never a phase's.
    log.warn(
      correlation.trace_id === undefined
        ? message
        : `${message} (trace_id=${correlation.trace_id} span_id=${correlation.span_id})`,
    );
  });
  return new TickTelemetryService(writer, resource, dryRun, correlation, {
    // Telemetry keeps the prose log's retention window — no knob of its own.
    // The sweep itself is wrapped so its failure warns like every other
    // telemetry failure instead of throwing into a tick (locked decision 9).
    ...(logRetentionDays !== undefined && {
      sweep: () => {
        try {
          writer.sweepRetention(logRetentionDays);
        } catch (error) {
          log.warn(
            `telemetry retention sweep failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    }),
  });
}
