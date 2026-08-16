"use client";

import type { OpenPrCard } from "@/console/activity.policy";
import { timeAgo } from "@/console/format";
import { TONE_TEXT, toneFor } from "@/console/tone";
import { cn } from "@/lib/utils";

/**
 * Open PRs, sorted by trouble (activity.policy owns the order), in the
 * design file's card language: blue mono id, state word right, detail line
 * below. Every row derives from landing/repair decisions the daemon
 * recorded — the last known word for each PR, never a live GitHub read.
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
    <aside
      className="flex w-[320px] shrink-0 flex-col gap-3 border-l px-5 py-[22px]"
      aria-label="open pull requests"
    >
      <div className="flex items-baseline gap-2.5">
        <p className="text-[13.5px] font-semibold">Open PRs</p>
        <p className="text-[12.5px] text-ink-dim">{cards.length} · sorted by trouble</p>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
        {cards.length === 0 ? (
          <p className="text-[12.5px] text-ink-dim">no open PRs in the replayed history</p>
        ) : (
          cards.map((card) => {
            const tone = toneFor(card.tag);
            return (
              <div
                key={card.number}
                className={cn(
                  "flex flex-col gap-[5px] rounded-[10px] border bg-card px-4 py-3",
                  tone === "red"
                    ? "border-[#3a1e26]"
                    : tone === "amber"
                      ? "border-[#3c3320]"
                      : "border-card-border",
                )}
              >
                <div className="flex items-baseline gap-2">
                  <p className="font-mono text-[13px] font-semibold text-accent-blue">
                    #{card.number}
                  </p>
                  <p
                    className={cn(
                      "text-[11.5px] font-semibold",
                      tone !== undefined ? TONE_TEXT[tone] : "text-muted-foreground",
                    )}
                  >
                    {card.tag}
                  </p>
                  <p className="ml-auto text-[11.5px] text-ink-faint">
                    {timeAgo(card.tagTs, nowMs)}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[12.5px] text-ink-dim">
                  {card.repair !== undefined && (
                    <span className="text-health-amber">
                      repair · {card.repair.action.toLowerCase()}
                    </span>
                  )}
                  {repo !== null && (
                    <a
                      className="text-accent-blue/80 underline-offset-2 hover:underline"
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
