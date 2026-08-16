"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FleetJson, ProjectAction, ProjectViewJson } from "@/console/fleet-view.interface";
// Type-only: the server module never enters the client bundle.
import type { GithubJson } from "@/fleet/github.service";

/** The TUI's poll cadence, kept: the daemon writes state at tick granularity. */
export const POLL_MS = 1000;
/** The TUI's log buffer cap, kept — a chatty daemon can't grow the tab unbounded. */
const MAX_LINES = 2000;
/**
 * While the reader has follow off, trimming would slide the text out from
 * under them (log-pane promises a paused read stays put), so the cap is
 * suspended up to this ceiling — the tab must still survive walking away
 * from a paused, chatty tail.
 */
const PAUSED_MAX_LINES = 20_000;

interface Envelope<T> {
  readonly data: T | null;
  readonly warnings?: readonly { readonly reason: string }[];
}

/** Envelope-aware fetch: non-2xx surfaces the server's reason, not "HTTP 400". */
async function fetchEnvelope<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || body?.data == null) {
    throw new Error(body?.warnings?.[0]?.reason ?? `request failed (${response.status})`);
  }
  return body.data;
}

/**
 * One poll cycle's worth of fleet state, the TUI refresh loop as a hook:
 * overlapping polls are skipped (not queued), a failed poll surfaces as
 * `pollError` while the last good views stay on screen, and polling pauses
 * while the tab is hidden — state changes land on the next visible poll.
 */
export function useFleet(): {
  readonly projects: readonly ProjectViewJson[];
  readonly pollError: string | null;
  readonly refresh: () => Promise<void>;
} {
  const [projects, setProjects] = useState<readonly ProjectViewJson[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await fetchEnvelope<FleetJson>("/api/v1/fleet");
      setProjects(data.projects);
      setPollError(null);
    } catch (error) {
      setPollError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return { projects, pollError, refresh };
}

/** One journal line as the pane renders it; `level` drives the tint only. */
export interface LogLine {
  readonly level: string;
  readonly text: string;
}

/**
 * The project's journal over the telemetry stream (#81/#82): one EventSource
 * on /api/v1/stream scoped to this project's log signal. The stream owns
 * replay, rotation, shared tailers, and resume — cursors ride the SSE `id:`
 * line, so the browser's automatic reconnect presents Last-Event-ID and no
 * line is lost across a blip. The client only appends and caps its buffer.
 */
export function useLogStream(
  projectKey: string | null,
  follow: boolean,
): {
  readonly lines: readonly LogLine[];
  /** False while the browser is (re)connecting the stream. */
  readonly live: boolean;
} {
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [live, setLive] = useState(false);
  // Bumped when a fatally-closed source needs a whole new subscription.
  const [generation, setGeneration] = useState(0);
  // Read through a ref so toggling follow never re-subscribes the stream
  // (the effect below deliberately keys on the project alone).
  const followRef = useRef(follow);
  followRef.current = follow;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the fatal-close re-subscribe trigger; the body reads it nowhere.
  useEffect(() => {
    setLines([]);
    setLive(false);
    if (projectKey === null) return;

    // Replay of a day's journal arrives as one SSE message per record;
    // coalescing appends per animation-ish frame keeps a thousand-line
    // catch-up from becoming a thousand renders.
    let pending: LogLine[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      setLines((previous) => {
        const next = [...previous, ...batch];
        const cap = followRef.current ? MAX_LINES : PAUSED_MAX_LINES;
        return next.length > cap ? next.slice(next.length - cap) : next;
      });
    };

    const source = new EventSource(
      `/api/v1/stream?projects=${encodeURIComponent(projectKey)}&signals=log`,
    );
    source.addEventListener("score.log.record", (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data as string) as {
          data?: { ts?: string; level?: string; body?: string };
        };
        const record = envelope.data;
        if (record?.body === undefined) return;
        const time = typeof record.ts === "string" ? record.ts.slice(11, 19) : "";
        pending.push({
          level: record.level ?? "",
          text: time === "" ? record.body : `[${time}] ${record.body}`,
        });
        flushTimer ??= setTimeout(flush, 48);
      } catch {
        // One unparseable frame is dropped; the stream's own warning frames
        // and the fleet poll own surfacing real trouble.
      }
    });
    source.onopen = () => setLive(true);
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // The browser retries transient drops itself (with Last-Event-ID) — but
    // a non-200 response (the stream's 410/400 cursor contract) closes the
    // source PERMANENTLY per the SSE spec, so a closed source schedules a
    // whole new subscription instead of dimming the marker forever.
    source.onerror = () => {
      setLive(false);
      if (source.readyState === EventSource.CLOSED && retryTimer === null) {
        retryTimer = setTimeout(() => setGeneration((current) => current + 1), 5_000);
      }
    };
    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      source.close();
    };
  }, [projectKey, generation]);

  return { lines, live };
}

/** Live GitHub reads are two gh calls server-side; poll them gently. */
const GITHUB_POLL_MS = 30_000;

/**
 * One project's live GitHub observation (open PRs with landing's verdicts,
 * open-issue count). The server caches per project, so this cadence is a
 * browser-side courtesy, not the real rate limiter. null while loading,
 * unconfigured, or unreadable — the panel falls back to telemetry truth.
 */
export function useGithub(projectKey: string | null): { readonly github: GithubJson | null } {
  const [github, setGithub] = useState<GithubJson | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    setGithub(null);
    if (projectKey === null) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const data = await fetchEnvelope<GithubJson>(
          `/api/v1/projects/${encodeURIComponent(projectKey)}/github`,
        );
        if (!cancelled) setGithub(data);
      } catch {
        // Unconfigured or unreadable: the panel's telemetry fallback owns
        // this state; a stale observation is worse than none.
        if (!cancelled) setGithub(null);
      } finally {
        inFlight.current = false;
      }
    };
    void poll();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, GITHUB_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectKey]);

  return { github };
}

/**
 * One action at a time, the TUI's contract kept: a failing supervisor must
 * not turn into a retry storm, and there is no optimistic state — the next
 * fleet poll reflects reality.
 */
export function useProjectAction(onSettled: () => Promise<void>): {
  readonly actionInFlight: boolean;
  readonly run: (projectKey: string, action: ProjectAction) => Promise<string | null>;
} {
  const [actionInFlight, setActionInFlight] = useState(false);
  const busy = useRef(false);

  const run = useCallback(
    async (projectKey: string, action: ProjectAction): Promise<string | null> => {
      if (busy.current) return null;
      busy.current = true;
      setActionInFlight(true);
      try {
        await fetchEnvelope<{ ok: boolean }>(
          `/api/v1/projects/${encodeURIComponent(projectKey)}/actions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        busy.current = false;
        setActionInFlight(false);
        await onSettled();
      }
    },
    [onSettled],
  );

  return { actionInFlight, run };
}
