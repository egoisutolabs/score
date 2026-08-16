"use client";

import type { OpenPrCard, ProjectFold } from "@/console/activity.policy";
import { timeAgo } from "@/console/format";
import { TONE_TEXT, toneFor } from "@/console/tone";
// Type-only: the server module never enters the client bundle.
import type { GithubJson, GithubPrJson } from "@/fleet/github.service";
import { cn } from "@/lib/utils";

/**
 * Live trouble order for GitHub-observed PRs, mirroring the landing
 * preconditions' severity: a conflict blocks everything, red checks next,
 * requested changes, then mere waiting.
 */
function liveTrouble(pr: GithubPrJson): number {
  if (pr.isDraft) return 6;
  if (pr.mergeable === "CONFLICTING") return 0;
  if (pr.checksFailing > 0) return 1;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return 2;
  if (pr.checksPending > 0) return 3;
  if (pr.reviewDecision === "REVIEW_REQUIRED") return 4;
  return 5;
}

function Verdict({
  ok,
  pending,
  label,
  detail,
}: {
  readonly ok: boolean;
  readonly pending?: boolean;
  readonly label: string;
  readonly detail: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={cn(
          "w-3 shrink-0 text-xs",
          pending ? "text-ink-faint" : ok ? "text-health-green" : "text-health-red",
        )}
      >
        {pending ? "·" : ok ? "✓" : "✗"}
      </span>
      <span className="w-[74px] shrink-0 text-[12.5px] text-foreground/80">{label}</span>
      <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function LiveCard({
  pr,
  fold,
  repo,
}: {
  readonly pr: GithubPrJson;
  readonly fold: ProjectFold | null;
  readonly repo: string | null;
}) {
  const activity = fold?.prs.get(pr.number);
  const tag = activity?.landing?.tag;
  const repair = activity?.repair;
  const repairActive =
    repair !== undefined && ["PINGED", "SPAWNED", "WORKING"].includes(repair.action);
  const trouble = liveTrouble(pr);
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-[10px] border bg-card px-4 py-3",
        trouble <= 1
          ? "border-[#3a1e26]"
          : trouble === 2
            ? "border-[#3c3320]"
            : "border-card-border",
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[13px] font-semibold text-accent-blue">
          #{pr.number}
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium" title={pr.title}>
          {pr.title}
        </span>
        {repairActive ? (
          <span className="ml-auto shrink-0 rounded-[5px] bg-[#241c0e] px-2 py-0.5 text-[11.5px] font-semibold text-health-amber">
            repair · {repair.action.toLowerCase()}
          </span>
        ) : tag !== undefined && tag !== "merged" ? (
          <span
            className={cn(
              "ml-auto shrink-0 text-[11.5px] font-semibold",
              toneFor(tag) !== undefined
                ? TONE_TEXT[toneFor(tag) as NonNullable<ReturnType<typeof toneFor>>]
                : "text-muted-foreground",
            )}
          >
            {tag}
          </span>
        ) : pr.isDraft ? (
          <span className="ml-auto shrink-0 text-[11.5px] text-ink-faint">draft</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Verdict
          ok={pr.mergeable !== "CONFLICTING"}
          pending={pr.mergeable === "UNKNOWN"}
          label="mergeable"
          detail={pr.mergeable.toLowerCase()}
        />
        <Verdict
          ok={pr.checksFailing === 0 && pr.checksPending === 0}
          pending={pr.checksFailing === 0 && pr.checksPending > 0}
          label="checks"
          detail={
            pr.checksTotal === 0
              ? "none reported"
              : pr.checksFailing > 0
                ? `${pr.checksFailing} failing of ${pr.checksTotal}`
                : pr.checksPending > 0
                  ? `${pr.checksPending} pending of ${pr.checksTotal}`
                  : `all ${pr.checksTotal} green`
          }
        />
        <Verdict
          ok={pr.reviewDecision === "APPROVED"}
          pending={pr.reviewDecision !== "APPROVED" && pr.reviewDecision !== "CHANGES_REQUESTED"}
          label="reviews"
          detail={(pr.reviewDecision ?? "no reviewers required").toLowerCase().replaceAll("_", " ")}
        />
      </div>
      {repo !== null && (
        <a
          className="self-start text-[11.5px] text-accent-blue/80 underline-offset-2 hover:underline"
          href={`https://github.com/${repo}/pull/${pr.number}`}
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
      )}
    </div>
  );
}

/**
 * Open PRs, sorted by trouble. With a live GitHub observation the cards are
 * GitHub's own open list wearing landing's verdict rows (mergeable, checks,
 * reviews), enriched with the journal's latest tag and repair state; when
 * GitHub is unconfigured or unreadable the panel falls back to what the
 * daemon recorded — the console never shows nothing because gh is down.
 */
export function PrPanel({
  github,
  fold,
  fallbackCards,
  repo,
  nowMs,
}: {
  readonly github: GithubJson | null;
  readonly fold: ProjectFold | null;
  readonly fallbackCards: readonly OpenPrCard[];
  readonly repo: string | null;
  readonly nowMs: number;
}) {
  const livePrs =
    github === null
      ? null
      : [...github.prs].sort((a, b) => liveTrouble(a) - liveTrouble(b) || b.number - a.number);
  const count = livePrs === null ? fallbackCards.length : livePrs.length;
  return (
    <aside
      className="flex w-[320px] shrink-0 flex-col gap-3 border-l px-5 py-[22px]"
      aria-label="open pull requests"
    >
      <div className="flex items-baseline gap-2.5">
        <p className="text-[13.5px] font-semibold">Open PRs</p>
        <p className="text-[12.5px] text-ink-dim">{count} · sorted by trouble</p>
        {livePrs === null && (
          <p className="ml-auto text-[11px] text-ink-faint" title="live GitHub read unavailable">
            journal only
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto">
        {livePrs !== null ? (
          livePrs.length === 0 ? (
            <p className="text-[12.5px] text-ink-dim">no open PRs</p>
          ) : (
            livePrs.map((pr) => <LiveCard key={pr.number} pr={pr} fold={fold} repo={repo} />)
          )
        ) : fallbackCards.length === 0 ? (
          <p className="text-[12.5px] text-ink-dim">no open PRs in the replayed history</p>
        ) : (
          fallbackCards.map((card) => {
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
