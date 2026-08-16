"use client";

import { useState } from "react";
import { REPLAY_DAYS } from "@/console/activity.hooks";
import {
  type DecisionEvent,
  historyStats,
  landingSpans,
  medianSpanMs,
  mergesPerDay,
} from "@/console/activity.policy";
import { StatTiles } from "@/console/stat-tiles";

// The widest chip is exactly what the stream replays (REPLAY_DAYS) — a
// wider label would present the same buffer as more history than it holds.
const RANGES = [7, REPLAY_DAYS] as const;
const DEFAULT_RANGE = REPLAY_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

// Categorical hues for project identity, assigned by sorted project order so
// the same fleet always colors the same way. Deliberately literal hexes:
// these are series colors, not status — the --health-* tokens stay reserved.
// Identity is always carried by the label beside the chip, never hue alone
// (the design's stacked-bar palette fails CVD checks; small multiples don't).
const PROJECT_HUES = ["#3ddc84", "#56d4dd", "#5aa9ff", "#c792ea"] as const;
const OVERFLOW_HUE = "#3d4a5c";

function hueFor(index: number): string {
  return PROJECT_HUES[index] ?? OVERFLOW_HUE;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "YYYY-MM-DD" → "Aug 9". String math, not Date — no local-zone drift. */
function formatDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(date)}`;
}

/** "18m" / "1h 12m" from a span in ms; sub-minute rounds to "<1m", never "0m". */
function spanText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "20:12" (UTC) — the merge row's time-of-day, same clock as the journal. */
function hhmm(ts: string): string {
  return ts.slice(11, 16);
}

// A span past 30 minutes is worth a glance — merges normally land well under.
const SLOW_SPAN_MS = 30 * 60_000;

// Repair-rate alarm thresholds: amber when a third of merges needed repair,
// red at half.
const REPAIR_AMBER = 0.3;
const REPAIR_RED = 0.5;

const EMPTY = "no merges in this range yet";

// Strip geometry: bars anchor to a 36px-tall lane with headroom above for
// the max/last count labels, mirroring merge-chart.tsx's label discipline.
const STRIP_BAR_MAX = 36;
const STRIP_H = 48;
const STUB_H = 2;

/**
 * One project's merges-per-day strip: chip + name + total, then a compact
 * bar lane in the project's hue. Small multiples instead of the design's
 * stacked bars — per-project lanes stay readable without hue decoding.
 */
function MergeStrip({
  name,
  hue,
  buckets,
}: {
  readonly name: string;
  readonly hue: string;
  readonly buckets: readonly { day: string; count: number }[];
}) {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const heights = buckets.map((b) =>
    max > 0 && b.count > 0 ? Math.max(4, (b.count / max) * STRIP_BAR_MAX) : STUB_H,
  );
  // Selective labels per strip: only the max day and the newest day carry a
  // count; everything else is hover-only.
  const last = buckets.length - 1;
  const labeled = new Set<number>();
  if (buckets.length > 0) {
    labeled.add(last);
    if (max > 0) labeled.add(buckets.findIndex((b) => b.count === max));
  }
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span
          className="h-[7px] w-[7px] shrink-0 self-center rounded-[2px]"
          style={{ backgroundColor: hue }}
          aria-hidden="true"
        />
        <span className="font-mono text-[13px] text-foreground">{name}</span>
        <span className="ml-auto font-mono text-[12px] text-muted-foreground tabular-nums">
          {total} merged
        </span>
      </div>
      <div className="relative mt-1" style={{ height: STRIP_H }}>
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-1">
          {buckets.map((bucket, index) => (
            <div
              key={bucket.day}
              className="min-w-0 flex-1 rounded-t-[3px] hover:brightness-125"
              style={{ height: heights[index], backgroundColor: hue }}
              title={`${formatDay(bucket.day)} — ${bucket.count} merged`}
            />
          ))}
        </div>
        {[...labeled].map((index) => (
          <span
            key={buckets[index].day}
            className="pointer-events-none absolute -translate-x-1/2 font-mono text-[10px] leading-none text-ink-faint tabular-nums"
            style={{
              left: `${((index + 0.5) / buckets.length) * 100}%`,
              bottom: heights[index] + 3,
            }}
          >
            {buckets[index].count}
          </span>
        ))}
      </div>
    </div>
  );
}

function repairToneClass(rate: number): string {
  if (rate >= REPAIR_RED) return "text-health-red";
  if (rate >= REPAIR_AMBER) return "text-health-amber";
  return "text-muted-foreground";
}

/**
 * The History tab: fleet-wide merge history over a selectable window, all of
 * it folded from the streamed decision events — nothing here is estimated.
 */
export function HistoryPage({
  events,
  projects,
  nowMs,
}: {
  readonly events: readonly DecisionEvent[];
  readonly projects: readonly { key: string }[];
  readonly nowMs: number;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(DEFAULT_RANGE);

  // Calendar-aligned window: every number on this page shares the strips'
  // span — [start of the oldest bucket's UTC day, now] — so the tiles, the
  // by-project table, and the bars can never disagree about "merged · Nd"
  // (a rolling now-Nd window would drop up to a day the buckets still show).
  const oldestDay = new Date(nowMs - (range - 1) * DAY_MS).toISOString().slice(0, 10);
  const sinceMs = Date.parse(`${oldestDay}T00:00:00.000Z`) - 1;

  // Sorted once: hue assignment, strips, and the by-project card must agree
  // on order or the same project would wear different colors per card.
  const keys = [...projects.map((project) => project.key)].sort();
  const perProject = keys.map((key, index) => ({
    key,
    hue: hueFor(index),
    stats: historyStats(events, key, sinceMs, nowMs),
    spans: landingSpans(events, key, sinceMs, nowMs),
    buckets: mergesPerDay(events, key, range, nowMs),
  }));

  const merged = perProject.reduce((sum, p) => sum + p.stats.merged, 0);
  const withoutRepair = perProject.reduce((sum, p) => sum + p.stats.mergedWithoutRepair, 0);
  const repairPings = perProject.reduce((sum, p) => sum + p.stats.repairPings, 0);
  // The fleet median comes from the pooled spans, not per-project medians —
  // medians don't sum.
  const fleetMedian = medianSpanMs(perProject.flatMap((p) => p.spans));

  const recent = perProject
    .flatMap((p) => p.spans)
    .sort((a, b) => Date.parse(b.mergedTs) - Date.parse(a.mergedTs))
    .slice(0, 20);

  const firstDay = perProject[0]?.buckets[0]?.day;
  const multiProject = keys.length > 1;

  return (
    <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-4 px-6 py-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold tracking-tight">History</h1>
        <p className="text-[13px] text-ink-dim">
          every merge the fleet has landed, from the daemons' own logs
        </p>
        <div className="ml-auto flex gap-0.5 rounded-md bg-muted p-0.5">
          {RANGES.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setRange(days)}
              className={`rounded-[5px] px-2.5 py-0.5 text-xs ${
                days === range
                  ? "bg-secondary text-foreground"
                  : "text-ink-dim hover:text-muted-foreground"
              }`}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      <StatTiles
        stats={[
          {
            label: `merged · ${range}d`,
            value: merged,
            ...(merged > 0 && { tone: "green" as const }),
          },
          {
            label: "landing → merge · median",
            value: fleetMedian === null ? "—" : spanText(fleetMedian),
          },
          {
            label: "merged without repair",
            value: merged === 0 ? "—" : `${Math.round((withoutRepair / merged) * 100)}%`,
          },
          {
            label: "repair pings",
            value: repairPings,
            ...(repairPings > 0 && { tone: "amber" as const }),
          },
        ]}
      />

      <div className="rounded-[10px] border border-card-border bg-card px-4 py-3">
        <div className="flex items-baseline gap-3">
          <p className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            merges per day
          </p>
          <p className="text-[11px] text-muted-foreground">last {range} days · per project</p>
        </div>
        {merged === 0 ? (
          <p className="py-4 text-[13px] text-ink-dim">{EMPTY}</p>
        ) : (
          <>
            <div className="mt-3 flex flex-col gap-4">
              {perProject.map((p) => (
                <MergeStrip key={p.key} name={p.key} hue={p.hue} buckets={p.buckets} />
              ))}
            </div>
            {firstDay !== undefined && (
              <div className="flex justify-between pt-2 font-mono text-[10px] text-ink-faint">
                <span>{formatDay(firstDay)}</span>
                <span>today</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <div className="overflow-hidden rounded-[10px] border border-card-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <p className="text-[13px] font-semibold">By project · {range}d</p>
          </div>
          <div className="grid grid-cols-[1fr_64px_72px_88px] gap-x-3 px-4 pt-2 pb-1 text-[11px] text-ink-dim">
            <span />
            <span className="text-right">merged</span>
            <span className="text-right">median</span>
            <span className="text-right">repair rate</span>
          </div>
          {perProject.length === 0 ? (
            <p className="px-4 pb-3 text-[13px] text-ink-dim">{EMPTY}</p>
          ) : (
            perProject.map((p) => {
              const repaired = p.stats.merged - p.stats.mergedWithoutRepair;
              const rate = p.stats.merged === 0 ? null : repaired / p.stats.merged;
              return (
                <div
                  key={p.key}
                  className="grid grid-cols-[1fr_64px_72px_88px] items-baseline gap-x-3 border-t border-border/50 px-4 py-2 text-[13px]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
                      style={{ backgroundColor: p.hue }}
                      aria-hidden="true"
                    />
                    <span className="truncate font-mono">{p.key}</span>
                  </span>
                  <span className="text-right font-mono tabular-nums">{p.stats.merged}</span>
                  <span className="text-right font-mono text-muted-foreground">
                    {p.stats.medianSpanMs === null ? "—" : spanText(p.stats.medianSpanMs)}
                  </span>
                  <span
                    className={`text-right font-mono ${rate === null ? "text-ink-faint" : repairToneClass(rate)}`}
                  >
                    {rate === null ? "—" : `${Math.round(rate * 100)}%`}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="overflow-hidden rounded-[10px] border border-card-border bg-card">
          <div className="flex items-baseline gap-2.5 border-b border-border px-4 py-3">
            <p className="text-[13px] font-semibold">Recent merges</p>
            <p className="text-xs text-ink-dim">newest first</p>
          </div>
          {recent.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-ink-dim">{EMPTY}</p>
          ) : (
            recent.map((row) => (
              <div
                key={`${row.project}#${row.number}@${row.mergedTs}`}
                className="flex items-baseline gap-2.5 border-t border-border/50 px-4 py-2"
              >
                <span className="shrink-0 font-mono text-[12.5px] font-semibold text-accent-blue">
                  #{row.number}
                </span>
                {multiProject && (
                  <span className="truncate text-[13px] text-muted-foreground">{row.project}</span>
                )}
                <span
                  className={`ml-auto shrink-0 font-mono text-[11.5px] ${
                    row.spanMs === null
                      ? "text-ink-faint"
                      : row.spanMs > SLOW_SPAN_MS
                        ? "text-health-amber"
                        : "text-muted-foreground"
                  }`}
                >
                  {row.spanMs === null ? "—" : spanText(row.spanMs)}
                </span>
                <span className="w-[46px] shrink-0 text-right font-mono text-[11.5px] text-ink-faint">
                  {hhmm(row.mergedTs)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
