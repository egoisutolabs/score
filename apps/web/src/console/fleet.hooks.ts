"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FleetJson,
  LogTailJson,
  ProjectAction,
  ProjectViewJson,
} from "@/console/fleet-view.interface";

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

/**
 * Cursor-poll tail of one project's dated logs. The server owns tail
 * semantics (rotation, truncation, caps) and says so via `reset`; the client
 * only appends and caps its buffer. Switching projects starts a fresh tail.
 */
export function useLogTail(
  projectKey: string | null,
  follow: boolean,
): {
  readonly file: string;
  readonly lines: readonly string[];
} {
  const [file, setFile] = useState("");
  const [lines, setLines] = useState<readonly string[]>([]);
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);
  // Read through a ref so toggling follow never restarts the poll loop (the
  // effect below deliberately keys on the project alone).
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    cursor.current = null;
    setFile("");
    setLines([]);
    if (projectKey === null) return;

    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const query =
          cursor.current === null ? "" : `?cursor=${encodeURIComponent(cursor.current)}`;
        const data = await fetchEnvelope<LogTailJson>(
          `/api/v1/projects/${encodeURIComponent(projectKey)}/logs${query}`,
        );
        if (cancelled) return;
        cursor.current = data.cursor;
        setFile(data.file);
        setLines((previous) => {
          const next = data.reset ? [...data.lines] : [...previous, ...data.lines];
          const cap = followRef.current ? MAX_LINES : PAUSED_MAX_LINES;
          return next.length > cap ? next.slice(next.length - cap) : next;
        });
      } catch {
        // A missing log file or a poll blip renders as an unchanged tail; the
        // fleet poll owns surfacing daemon trouble.
      } finally {
        inFlight.current = false;
      }
    };

    void poll();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectKey]);

  return { file, lines };
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
