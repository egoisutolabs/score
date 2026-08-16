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
        "rounded-[5px] px-2.5 py-[3px] text-xs",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        active ? "bg-secondary text-foreground" : "text-ink-dim hover:text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The design file's Activity card: Events is the decision feed (what the
 * daemon decided, newest first, verb column in the design's grid), Debug is
 * the raw journal — outcomes vs. mechanics. The journal keeps its follow
 * semantics; the events feed is newest-first and needs none.
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
  const paneLive = debug ? journal.live : live;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-card-border bg-card"
      aria-label="activity"
    >
      <div className="flex items-center gap-3.5 border-b px-[18px] py-3">
        <p className="text-[13.5px] font-semibold">Activity</p>
        <div className="flex gap-0.5 rounded-md bg-muted p-0.5">
          <Tab label="Events" active={!debug} onClick={() => onDebugChange(false)} />
          <Tab label="Debug" active={debug} onClick={() => onDebugChange(true)} />
        </div>
        {degraded && !debug && (
          <p className="text-xs text-health-amber">history may be incomplete</p>
        )}
        <p
          className={cn(
            "ml-auto flex items-center gap-[7px] text-xs",
            paneLive ? "text-health-green" : "text-health-amber",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              paneLive ? "bg-health-green" : "bg-health-amber",
            )}
          />
          {paneLive ? "live" : "reconnecting"}
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
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {rows.length === 0 ? (
            <p className="px-3 text-[13px] text-ink-dim">no decisions in the replayed history</p>
          ) : (
            rows.slice(0, FEED_ROWS).map((row) => {
              const tone = toneFor(row.kind);
              return (
                <div
                  // Rows are derived, not owned: the same decision folds to
                  // the same key every render.
                  key={`${row.ts}-${row.kind}-${row.text}`}
                  className="grid grid-cols-[52px_88px_1fr] items-baseline gap-x-3.5 rounded-md px-3 py-[5px] hover:bg-muted"
                >
                  <span className="font-mono text-xs text-ink-faint">{hms(row.ts)}</span>
                  <span
                    className={cn(
                      "truncate font-mono text-[11.5px] font-semibold",
                      tone !== undefined ? TONE_TEXT[tone] : "text-muted-foreground",
                    )}
                    title={row.kind}
                  >
                    {row.kind}
                  </span>
                  <span className="text-[13px] break-words text-muted-foreground">{row.text}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
