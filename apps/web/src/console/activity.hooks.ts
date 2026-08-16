"use client";

import { useEffect, useState } from "react";
import type { DecisionEvent } from "@/console/activity.policy";

/** How far back the fleet's decision history replays on subscribe. */
export const REPLAY_DAYS = 14;
/**
 * Decision events only. Ticks and phase spans are deliberately not
 * subscribed: at one per minute per project they would drown the buffer
 * with non-decisions.
 */
const DECISION_NAMES = [
  "score.dispatch.decision",
  "score.landing.decision",
  "score.repair.decision",
  "score.cleanup.decision",
].join(",");
/**
 * Dropped at ingest: scan results that found nothing to do. Repair emits
 * NOT_NEEDED for every healthy open PR every pass, and cleanup emits
 * NOT_FOUND for every historical PR with no worktree — dozens of no-ops per
 * pass that no derivation consumes (historyStats gates on active repair,
 * folds read repair state only through ACTIVE_REPAIR), and a feed of
 * "not found" rows reads as breakage. The console shows decisions, not
 * scans that came back empty.
 */
const SCAN_NOISE: Readonly<Record<string, ReadonlySet<string>>> = {
  "score.repair.decision": new Set(["NOT_NEEDED", "SKIPPED"]),
  "score.cleanup.decision": new Set(["NOT_FOUND"]),
};
/**
 * After the noise filter the dominant residue is landing's per-observation
 * event (~720/day per open PR at the default 60s tick), so this holds
 * roughly 14 days × 5 open PRs. Oldest fall off first, and a trim flips
 * `degraded` — silently presenting a shortened window as complete history
 * is exactly what that flag exists to prevent.
 */
const MAX_EVENTS = 50_000;

/**
 * One fleet-wide subscription to the decision-event stream: replay from
 * REPLAY_DAYS ago, then follow live. The stream owns cursors and resume
 * (Last-Event-ID on the browser's automatic reconnect); this hook only
 * accumulates. Aggregation over the buffer is activity.policy's job.
 */
export function useEventStream(projectKeys: readonly string[]): {
  readonly events: readonly DecisionEvent[];
  readonly live: boolean;
  /** True once the stream reported a warning: history may be incomplete. */
  readonly degraded: boolean;
} {
  const [events, setEvents] = useState<readonly DecisionEvent[]>([]);
  const [live, setLive] = useState(false);
  const [degraded, setDegraded] = useState(false);
  // Bumped when a fatally-closed source needs a whole new subscription.
  const [generation, setGeneration] = useState(0);
  // The stream discovers projects at subscribe time, so a project added
  // while the page is open would never appear — membership changes force a
  // fresh subscription (and a fresh buffer: replaying into the old one
  // would double-count every event-derived number).
  const membership = [...projectKeys].sort().join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `membership` and `generation` are the re-subscribe triggers; the body deliberately reads nothing else that changes.
  useEffect(() => {
    setEvents([]);
    setDegraded(false);
    // Pinned per subscription: recomputing on a same-subscription reconnect
    // would silently re-replay a different window (Last-Event-ID owns resume).
    const since = new Date(Date.now() - REPLAY_DAYS * 86_400_000).toISOString();
    // Replay bursts arrive one SSE message per record; coalescing appends
    // keeps a two-week catch-up from becoming thousands of renders.
    let pending: DecisionEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      setEvents((previous) => {
        const next = [...previous, ...batch];
        if (next.length <= MAX_EVENTS) return next;
        // Trimming inside the advertised window means the numbers derived
        // from this buffer stop being complete — say so.
        setDegraded(true);
        return next.slice(next.length - MAX_EVENTS);
      });
    };

    const source = new EventSource(
      `/api/v1/stream?signals=event&names=${DECISION_NAMES}&since=${encodeURIComponent(since)}`,
    );
    // A warning frame (unreadable segment, malformed record) means the
    // replay is incomplete — the page must say so instead of presenting
    // partial history as the whole truth.
    source.addEventListener("score.stream.warning", () => setDegraded(true));
    source.addEventListener("score.telemetry.event", (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data as string) as { data?: DecisionEvent };
        const record = envelope.data;
        if (record?.name === undefined || record.ts === undefined) return;
        if (
          typeof record.attributes?.action === "string" &&
          SCAN_NOISE[record.name]?.has(record.attributes.action)
        ) {
          return;
        }
        pending.push(record);
        flushTimer ??= setTimeout(flush, 48);
      } catch {
        // One unparseable frame is dropped; the stream's warning frames own
        // surfacing real trouble.
      }
    });
    source.onopen = () => setLive(true);
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    source.onerror = () => {
      setLive(false);
      // A non-200 response (the stream's own 410 CURSOR_EXPIRED / 400
      // cursor contract) fails an EventSource PERMANENTLY per the SSE spec
      // — no automatic retry. "Expired" means "subscribe fresh", so a
      // closed source schedules a whole new subscription (fresh window,
      // fresh buffer) instead of showing "reconnecting" forever over
      // frozen data.
      if (source.readyState === EventSource.CLOSED && retryTimer === null) {
        retryTimer = setTimeout(() => setGeneration((current) => current + 1), 5_000);
      }
    };
    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      source.close();
    };
  }, [membership, generation]);

  return { events, live, degraded };
}
