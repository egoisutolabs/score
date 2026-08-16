import { randomUUID } from "node:crypto";
import type {
  TelemetryAttributes,
  TelemetryEvent,
  TelemetryRecord,
} from "@score/core/telemetry/telemetry.interface";
import { TELEMETRY_VERSION } from "@score/core/telemetry/telemetry.interface";
import {
  GAP_RECORD_NAME,
  type TelemetryLogService,
} from "@score/core/telemetry/telemetry-log.service";
import type { Logger } from "@score/shared/log";
import type { TelemetryRenderContext } from "./telemetry.render";

/** Correlation IDs are hex derived from crypto.randomUUID() — no OTel SDK, no traceparent. */
const hexId = (): string => randomUUID().replaceAll("-", "");

/**
 * The #79 wiring around the phases: one score.tick span per pass, one
 * score.phase child per phase run, decision events mapped at composition
 * (locked decision 10) — all appended through the append-only log. Locked
 * decision 9 makes failure visible but never authoritative: no method here
 * throws, phases never see this object, and a FAILED append costs one debug
 * line, at most one warn per pass, and a gap record counted on recovery.
 */
export class PassTelemetry {
  /** Appends lost since the last APPENDED — the count the recovery gap reports. */
  private lost = 0;
  private warnedThisPass = false;
  private traceId = "";
  private tickSpanId = "";
  private tickNumber = 0;
  private tickStartedAt = 0;
  private phaseSpanId = "";
  private phaseStartedAt = 0;

  constructor(
    private readonly sink: Pick<TelemetryLogService, "append">,
    private readonly project: string,
    private readonly dryRun: boolean,
    private readonly log: Logger,
  ) {}

  /** Opens the pass's root span; nothing is appended until closeTick. */
  openTick(tick: number): void {
    this.traceId = hexId();
    this.tickSpanId = hexId();
    this.tickNumber = tick;
    this.tickStartedAt = Date.now();
    this.warnedThisPass = false;
  }

  closeTick(status: "ok" | "error"): void {
    this.appendSpan("score.tick", this.tickSpanId, undefined, this.tickStartedAt, status, {
      trace_id: this.traceId,
      tick: this.tickNumber,
      dry_run: this.dryRun,
    });
  }

  beginPhase(): void {
    this.phaseSpanId = hexId();
    this.phaseStartedAt = Date.now();
  }

  endPhase(name: string, status: "ok" | "error"): void {
    this.appendSpan("score.phase", this.phaseSpanId, this.tickSpanId, this.phaseStartedAt, status, {
      trace_id: this.traceId,
      phase: name,
      dry_run: this.dryRun,
    });
  }

  /** Mapped decision records, correlated to the phase span currently open. */
  decisions(render: (ctx: TelemetryRenderContext) => readonly TelemetryEvent[]): void {
    const ctx: TelemetryRenderContext = {
      project: this.project,
      ts: new Date().toISOString(),
      dryRun: this.dryRun,
    };
    let records: readonly TelemetryEvent[];
    // The mapper is pure, but a throw here must degrade like a failed append
    // (locked decision 9) — never bubble into the phase that just succeeded.
    try {
      records = render(ctx);
    } catch {
      this.recordFailure("decision mapping threw", this.phaseSpanId);
      return;
    }
    for (const record of records) {
      this.append(
        {
          ...record,
          attributes: { ...record.attributes, trace_id: this.traceId, span_id: this.phaseSpanId },
        },
        this.phaseSpanId,
      );
    }
  }

  private appendSpan(
    name: string,
    spanId: string,
    parentSpanId: string | undefined,
    startedAt: number,
    status: "ok" | "error",
    attributes: TelemetryAttributes,
  ): void {
    this.append(
      {
        v: TELEMETRY_VERSION,
        ts: new Date().toISOString(),
        project: this.project,
        signal: "span",
        name,
        span_id: spanId,
        ...(parentSpanId === undefined ? {} : { parent_span_id: parentSpanId }),
        duration_ms: Date.now() - startedAt,
        status,
        attributes,
      },
      spanId,
    );
  }

  private append(record: TelemetryRecord, spanId: string): void {
    // TelemetryLogService.append never throws by contract, but the sink is a
    // seam — a throwing substitute must degrade to FAILED, never reach a phase.
    let outcome: "APPENDED" | "FAILED";
    try {
      outcome = this.sink.append(record);
    } catch {
      outcome = "FAILED";
    }
    if (outcome === "FAILED") {
      this.recordFailure(`append FAILED: ${record.name}`, spanId);
      return;
    }
    if (this.lost > 0) {
      const lost = this.lost;
      // Reset before the gap append: a FAILED gap re-enters recordFailure and
      // is itself counted, so the next success reports it — bounded, no loop.
      this.lost = 0;
      this.append(
        {
          v: TELEMETRY_VERSION,
          ts: new Date().toISOString(),
          project: this.project,
          signal: "event",
          name: GAP_RECORD_NAME,
          attributes: { lost, trace_id: this.traceId, dry_run: this.dryRun },
        },
        spanId,
      );
    }
  }

  private recordFailure(reason: string, spanId: string): void {
    this.lost += 1;
    // The logger is only the reporting channel and can share the failing disk
    // with the sink; the loss is already counted above, so a throw from either
    // log call must die here, not fail the phase (locked decision 9).
    try {
      this.log.debug(`telemetry ${reason} (trace_id=${this.traceId} span_id=${spanId})`);
      if (!this.warnedThisPass) {
        this.warnedThisPass = true;
        this.log.warn(
          `telemetry appends failing; records are lost until recovery (trace_id=${this.traceId} span_id=${spanId})`,
        );
      }
    } catch {
      // Counted loss with no reporting channel left — nothing safe remains.
    }
  }
}
