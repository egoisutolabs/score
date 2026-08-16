"use client";

import { useEffect, useRef, useState } from "react";
import type { DecisionEvent } from "@/console/activity.policy";

/** How far back the fleet's decision history replays on subscribe. */
export const REPLAY_DAYS = 14;
/**
 * Decision events only — a couple per pass, so 14 days across a fleet stays
 * small. Ticks and phase spans are deliberately not subscribed: at one per
 * minute per project they would drown the buffer with non-decisions.
 */
const DECISION_NAMES = [
  "score.dispatch.decision",
  "score.landing.decision",
  "score.repair.decision",
  "score.cleanup.decision",
].join(",");
/** Backstop for a pathological backlog; oldest fall off first. */
const MAX_EVENTS = 20_000;

/**
 * One fleet-wide subscription to the decision-event stream: replay from
 * REPLAY_DAYS ago, then follow live. The stream owns cursors and resume
 * (Last-Event-ID on the browser's automatic reconnect); this hook only
 * accumulates. Aggregation over the buffer is activity.policy's job.
 */
export function useEventStream(): {
  readonly events: readonly DecisionEvent[];
  readonly live: boolean;
} {
  const [events, setEvents] = useState<readonly DecisionEvent[]>([]);
  const [live, setLive] = useState(false);
  const sinceRef = useRef<string | null>(null);
  // The replay boundary is pinned once per mount: recomputing it on a
  // reconnect would silently re-replay a different window.
  sinceRef.current ??= new Date(Date.now() - REPLAY_DAYS * 86_400_000).toISOString();

  useEffect(() => {
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
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };

    const source = new EventSource(
      `/api/v1/stream?signals=event&names=${DECISION_NAMES}&since=${encodeURIComponent(sinceRef.current ?? "")}`,
    );
    source.addEventListener("score.telemetry.event", (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data as string) as { data?: DecisionEvent };
        const record = envelope.data;
        if (record?.name === undefined || record.ts === undefined) return;
        pending.push(record);
        flushTimer ??= setTimeout(flush, 48);
      } catch {
        // One unparseable frame is dropped; the stream's warning frames own
        // surfacing real trouble.
      }
    });
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      source.close();
    };
  }, []);

  return { events, live };
}
