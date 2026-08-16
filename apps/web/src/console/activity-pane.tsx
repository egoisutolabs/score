"use client";

import type { FeedRow } from "@/console/activity.policy";
import type { LogLine } from "@/console/fleet.hooks";
import { hms } from "@/console/format";
import { LogPane } from "@/console/log-pane";
import { TONE_TEXT, toneFor } from "@/console/tone";
import { cn } from "@/lib/utils";

/** The feed shows this many rows; older history lives in the buffer for the chart. */
const FEED_ROWS = 200;

function Tab({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-sm px-2 py-0.5 text-[11px]",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The mockup's Activity box: Events is the decision feed (what the daemon
 * decided, newest first), Debug is the raw journal — the same split as
 * "outcomes vs. mechanics". The journal keeps its follow semantics; the
 * events feed is newest-first and needs none.
 */
export function ActivityPane({
  rows,
  live,
  degraded,
  journal,
  follow,
  onFollowChange,
  scrollTopNonce,
  debug,
  onDebugChange,
}: {
  readonly rows: readonly FeedRow[];
  readonly live: boolean;
  /** The stream warned mid-replay: what's shown may be missing history. */
  readonly degraded: boolean;
  readonly journal: { readonly lines: readonly LogLine[]; readonly live: boolean };
  readonly follow: boolean;
  readonly onFollowChange: (follow: boolean) => void;
  readonly scrollTopNonce: number;
  readonly debug: boolean;
  readonly onDebugChange: (debug: boolean) => void;
}) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col rounded-md border bg-card"
      aria-label="activity"
    >
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <p className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">activity</p>
        <Tab label="Events" active={!debug} onClick={() => onDebugChange(false)} />
        <Tab label="Debug" active={debug} onClick={() => onDebugChange(true)} />
        {degraded && !debug && (
          <p className="text-[11px] text-health-amber">history may be incomplete</p>
        )}
        <p className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              (debug ? journal.live : live) ? "bg-health-green" : "bg-health-amber",
            )}
          />
          {(debug ? journal.live : live) ? "live" : "reconnecting"}
        </p>
      </div>
      {debug ? (
        <LogPane
          lines={journal.lines}
          live={journal.live}
          follow={follow}
          onFollowChange={onFollowChange}
          scrollTopNonce={scrollTopNonce}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono text-[12px] leading-[1.8]">
          {rows.length === 0 ? (
            <p className="text-muted-foreground">no decisions in the replayed history</p>
          ) : (
            rows.slice(0, FEED_ROWS).map((row) => {
              const tone = toneFor(row.kind);
              return (
                // Rows are derived, not owned: the same decision folds to the
                // same key every render, and duplicates cannot occur within
                // one (ts, kind, text) triple from a single stream.
                <div key={`${row.ts}-${row.kind}-${row.text}`} className="flex gap-3">
                  <span className="shrink-0 text-muted-foreground">{hms(row.ts)}</span>
                  <span
                    className={cn(
                      "w-28 shrink-0 truncate",
                      tone !== undefined ? TONE_TEXT[tone] : "text-foreground/80",
                    )}
                    title={row.kind}
                  >
                    {row.kind}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-foreground/90">{row.text}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
