"use client";

import { useMemo } from "react";

/**
 * The console's signature: the daemon's only clock, made visible. A thin bar
 * fills once per tick interval, phase-aligned to the last pass the daemon
 * recorded, so a healthy fleet reads as a steady metronome and a stopped one
 * as a dead track. Purely presentational — the fleet poll owns truth.
 */
export function TickPulse({
  startedAt,
  intervalMs,
}: {
  readonly startedAt: string | null;
  readonly intervalMs: number;
}) {
  // Phase is computed once per recorded pass: recomputing on every poll would
  // restart the CSS animation (delay changes reset it) and turn the metronome
  // into a stutter.
  const delayMs = useMemo(() => {
    if (startedAt === null) return null;
    const started = Date.parse(startedAt);
    if (Number.isNaN(started)) return null;
    return ((Date.now() - started) % intervalMs) + intervalMs;
  }, [startedAt, intervalMs]);

  return (
    // A project with no recorded pass shows a dimmed, empty track — a dead
    // metronome, deliberately distinct from a bar that is merely at 0%.
    <div
      className={`h-[3px] w-44 overflow-hidden rounded-full ${delayMs === null ? "bg-border/50" : "bg-border"}`}
      aria-hidden="true"
    >
      {delayMs !== null && (
        <div
          key={startedAt}
          className="tick-pulse h-full w-full bg-muted-foreground"
          style={
            {
              "--tick-interval": `${intervalMs}ms`,
              "--tick-delay": `-${delayMs}ms`,
            } as React.CSSProperties
          }
        />
      )}
    </div>
  );
}
