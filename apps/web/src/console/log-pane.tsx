"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Scrolling this far off the bottom is a deliberate read, not drift. */
const FOLLOW_SLACK_PX = 24;

/**
 * The live tail. Follow pins the view to the newest line; scrolling up is how
 * a reader disengages (like a terminal), and `f`/`G` re-engage. While follow
 * is off, history is not trimmed (up to a hard ceiling — see fleet.hooks.ts),
 * so a paused read stays put instead of sliding as the buffer caps.
 */
export function LogPane({
  file,
  lines,
  follow,
  onFollowChange,
  scrollTopNonce,
}: {
  readonly file: string;
  readonly lines: readonly string[];
  readonly follow: boolean;
  readonly onFollowChange: (follow: boolean) => void;
  /** Bumped by the `g` shortcut: jump to the top of the buffer. */
  readonly scrollTopNonce: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Distinguishes our own pin-to-bottom scrolls from the reader's wheel: the
  // scroll event fires for both, and treating ours as theirs would flip
  // follow off on every appended line.
  const pinning = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `lines` is the re-pin trigger — each appended line must re-run the pin even though the body never reads it.
  useEffect(() => {
    const pane = scrollRef.current;
    if (!follow || pane === null) return;
    const before = pane.scrollTop;
    pane.scrollTop = pane.scrollHeight;
    // Flag only an assignment that actually moved: a no-op fires no scroll
    // event, so nothing would clear the flag and it would eat the reader's
    // next real scroll instead.
    if (pane.scrollTop !== before) pinning.current = true;
  }, [follow, lines]);

  useEffect(() => {
    if (scrollTopNonce === 0) return;
    const pane = scrollRef.current;
    if (pane === null) return;
    const before = pane.scrollTop;
    pane.scrollTop = 0;
    if (pane.scrollTop !== before) pinning.current = true;
  }, [scrollTopNonce]);

  const handleScroll = (): void => {
    const pane = scrollRef.current;
    if (pane === null) return;
    if (pinning.current) {
      pinning.current = false;
      return;
    }
    const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - FOLLOW_SLACK_PX;
    if (follow && !atBottom) onFollowChange(false);
    else if (!follow && atBottom) onFollowChange(true);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="logs">
      <div className="flex items-center gap-2 border-b px-6 py-2">
        <p className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">logs</p>
        {file !== "" && <p className="text-[11px] text-muted-foreground">{file}</p>}
        <button
          type="button"
          onClick={() => onFollowChange(!follow)}
          className={cn(
            "ml-auto rounded-sm px-1.5 py-0.5 text-[11px]",
            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
            follow ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary",
          )}
        >
          follow
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-3"
      >
        {lines.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">no log lines yet today</p>
        ) : (
          <pre className="text-[12px] leading-[1.7] break-words whitespace-pre-wrap text-foreground/90">
            {lines.join("\n")}
          </pre>
        )}
      </div>
    </section>
  );
}
