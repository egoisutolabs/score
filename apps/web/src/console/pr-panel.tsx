"use client";

import type { OpenPrCard } from "@/console/activity.policy";
import { timeAgo } from "@/console/format";
import { TONE_TEXT, toneFor } from "@/console/tone";
import { cn } from "@/lib/utils";

/**
 * Open PRs, sorted by trouble (activity.policy owns the order). Every row is
 * derived from landing/repair decisions the daemon actually recorded — the
 * panel shows the last known word for each PR, never a live GitHub read.
 */
export function PrPanel({
  cards,
  repo,
  nowMs,
}: {
  readonly cards: readonly OpenPrCard[];
  /** owner/repo for links; null hides them (resolved.json predates the field). */
  readonly repo: string | null;
  readonly nowMs: number;
}) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l" aria-label="open pull requests">
      <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
        <p className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">open PRs</p>
        <p className="text-[11px] text-muted-foreground">{cards.length} · sorted by trouble</p>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {cards.length === 0 ? (
          <p className="px-1 text-[12px] text-muted-foreground">
            no open PRs in the replayed history
          </p>
        ) : (
          cards.map((card) => {
            const tone = toneFor(card.tag);
            return (
              <div
                key={card.number}
                className={cn(
                  "rounded-md border bg-card px-3 py-2.5",
                  tone === "red" && "border-l-2 border-l-health-red",
                  tone === "amber" && "border-l-2 border-l-health-amber",
                )}
              >
                <div className="flex items-baseline gap-2">
                  <p className="text-[13px] font-semibold">#{card.number}</p>
                  <p className={cn("text-[12px]", tone !== undefined && TONE_TEXT[tone])}>
                    {card.tag}
                  </p>
                  <p className="ml-auto text-[11px] text-muted-foreground">
                    {timeAgo(card.tagTs, nowMs)}
                  </p>
                </div>
                <div className="mt-1 flex items-center gap-3">
                  {card.repair !== undefined && (
                    <p className="text-[11px] text-health-amber">
                      repair · {card.repair.action.toLowerCase()}
                    </p>
                  )}
                  {repo !== null && (
                    <a
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                      href={`https://github.com/${repo}/pull/${card.number}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      GitHub ↗
                    </a>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
