"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEventStream } from "@/console/activity.hooks";
import {
  feedRows,
  foldProject,
  mergedTodayFleet,
  mergesPerDay,
  openPrs,
  TROUBLE_RANK,
  tiles,
} from "@/console/activity.policy";
import { ActivityPane } from "@/console/activity-pane";
import { AlertBanner, troubledProjects } from "@/console/alert-banner";
import { ConfigPage } from "@/console/config-page";
import { useFleet, useGithub, useLogStream, useProjectAction } from "@/console/fleet.hooks";
import { DOT_WORD, type ProjectAction, type ProjectViewJson } from "@/console/fleet-view.interface";
import { timeAgo } from "@/console/format";
import { HistoryPage } from "@/console/history-page";
import { MergeChart } from "@/console/merge-chart";
import { PrPanel } from "@/console/pr-panel";
import { ProjectRail, type RailStatus } from "@/console/project-rail";
import { StatTiles } from "@/console/stat-tiles";
import { toneFor } from "@/console/tone";
import { cn } from "@/lib/utils";

const SHORTCUTS = "j/k select · x stop/start · r restart · f follow · g/G · ? help";
const HELP =
  "j/k select project · x stop/start via supervisor · r restart · f toggle follow (Debug tab) · g top · G end — closing this tab never touches the fleet";
const CHART_DAYS = 14;
const TABS = ["fleet", "history", "config"] as const;
type Tab = (typeof TABS)[number];

/** The design file's pixel-grid wordmark: a 5×4 field, top row lit. */
function Logo() {
  const CELLS = 20;
  const LIT = 9;
  return (
    <div className="grid grid-cols-5 gap-0.5" aria-hidden="true">
      {Array.from({ length: CELLS }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a static brand mark; cells have no identity beyond position.
          key={index}
          className={cn("size-[7px]", index < LIT ? "bg-health-green" : "bg-[#2b3646]")}
        />
      ))}
    </div>
  );
}

/** One derived rail line per project — the worst truth wins. */
function railStatus(
  project: ProjectViewJson,
  events: Parameters<typeof foldProject>[0],
  nowMs: number,
): RailStatus {
  if (project.dot === "red") {
    const since = project.status === null ? "" : ` · ${timeAgo(project.status.updated_at, nowMs)}`;
    return { text: `crashed${since}`, tone: "red" };
  }
  const fold = foldProject(events, project.key);
  for (const [number, state] of fold.prs) {
    // A merged PR's last repair action lingers in the fold forever (repair
    // emits no terminal event) — only unmerged PRs can be "repairing".
    if (state.landing?.tag === "merged") continue;
    if (
      state.repair !== undefined &&
      ["PINGED", "SPAWNED", "WORKING"].includes(state.repair.action)
    ) {
      return { text: `repairing #${number}`, tone: "amber" };
    }
  }
  let worst: { number: number; tag: string; rank: number } | null = null;
  for (const [number, state] of fold.prs) {
    if (state.landing === undefined || state.landing.tag === "merged") continue;
    const rank = TROUBLE_RANK.indexOf(state.landing.tag);
    if (
      rank !== -1 &&
      rank <= TROUBLE_RANK.indexOf("unresolved") &&
      (worst === null || rank < worst.rank)
    ) {
      worst = { number, tag: state.landing.tag, rank };
    }
  }
  if (worst !== null) {
    return { text: `#${worst.number} ${worst.tag}`, tone: toneFor(worst.tag) };
  }
  if (!project.enabled) return { text: "disabled in config" };
  return { text: project.pid !== null ? "running" : DOT_WORD[project.dot] };
}

/**
 * The console shell, the design file's chrome: wordmark, tab nav
 * (Fleet/History/Config — Brake waits for its daemon feature), fleet
 * summary right, alert strips, then the active tab. Everything rendered is
 * derived from the fleet poll and the decision-event stream.
 */
export function Console() {
  const { projects, pollError, refresh } = useFleet();
  const { events, live, degraded } = useEventStream(projects.map((project) => project.key));
  const [tab, setTabState] = useState<Tab>("fleet");
  // Tabs are addressable (#history, #config) so a view can be linked or
  // reloaded into; read after mount — the server render can't see the hash.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1) as Tab;
    if (TABS.includes(fromHash)) setTabState(fromHash);
  }, []);
  const setTab = useCallback((next: Tab): void => {
    setTabState(next);
    window.history.replaceState(null, "", next === "fleet" ? "#" : `#${next}`);
  }, []);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [scrollTopNonce, setScrollTopNonce] = useState(0);
  const [help, setHelp] = useState(false);
  // Journal-first: the raw tail is the fleet view's default pane — it is
  // never empty for a project that has ever run, unlike the derived feed.
  const [debug, setDebug] = useState(true);
  const { actionInFlight, run } = useProjectAction(refresh);
  // One coarse clock for every "Nm ago" on screen; ticks with the fleet poll.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  const selected = projects.find((project) => project.key === selectedKey);
  // The journal stream only runs while the Debug tab is showing.
  const journal = useLogStream(debug && tab === "fleet" ? (selected?.key ?? null) : null, follow);
  const { github } = useGithub(selected?.key ?? null);

  const select = useCallback((key: string): void => {
    setSelectedKey(key);
    setFollow(true);
  }, []);

  // The TUI's selection healing: first project when nothing (or a vanished
  // project) is selected.
  useEffect(() => {
    if (projects.length === 0) return;
    if (selectedKey === null || !projects.some((project) => project.key === selectedKey)) {
      select(projects[0]?.key ?? "");
    }
  }, [projects, selectedKey, select]);

  const act = useCallback(
    (project: ProjectViewJson, action: ProjectAction): void => {
      // The TUI's disabled-project contract, mirrored before the request:
      // stopping a running disabled job is fine, starting one is not.
      if (action !== "stop" && !project.enabled) {
        toast.error(`'${project.key}' is disabled in config — not starting`);
        return;
      }
      void run(project.key, action).then((error) => {
        if (error === null) return;
        // The API stays enum-only; the console owns turning reasons into
        // operator guidance.
        toast.error(
          error === "DEFINITION_MISSING"
            ? `'${project.key}' isn't installed yet — start the daemon first: score up ${project.key}`
            : `${action} '${project.key}' failed (${error})`,
        );
      });
    },
    [run],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      // The keyboard vocabulary drives the fleet view; other tabs read only.
      if (tab !== "fleet") return;

      const index = projects.findIndex((project) => project.key === selectedKey);
      const moveTo = (next: number): void => {
        const project = projects[Math.max(0, Math.min(projects.length - 1, next))];
        if (project !== undefined) select(project.key);
      };

      if (event.key === "j" || event.key === "ArrowDown") moveTo(index + 1);
      else if (event.key === "k" || event.key === "ArrowUp") moveTo(index - 1);
      else if (event.key === "f") setFollow((value) => !value);
      else if (event.key === "G") setFollow(true);
      else if (event.key === "g") {
        setFollow(false);
        setScrollTopNonce((nonce) => nonce + 1);
      } else if (event.key === "?") setHelp((value) => !value);
      else if (event.key === "x" && selected !== undefined) {
        act(selected, selected.pid !== null ? "stop" : "start");
      } else if (event.key === "r" && selected !== undefined) act(selected, "restart");
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [projects, selectedKey, selected, select, act, tab]);

  const running = projects.filter((project) => project.pid !== null).length;
  const down = projects.filter((project) => project.dot === "red").length;
  const mergedToday = mergedTodayFleet(events, nowMs);
  const troubled = troubledProjects(projects);
  const statuses = new Map<string, RailStatus>(
    projects.map((project) => [project.key, railStatus(project, events, nowMs)]),
  );

  const selectedKeyOrNull = selected?.key ?? null;
  const stats = selectedKeyOrNull === null ? null : tiles(events, selectedKeyOrNull, nowMs);
  const fold = selectedKeyOrNull === null ? null : foldProject(events, selectedKeyOrNull);
  const cards = fold === null ? [] : openPrs(fold);
  const buckets =
    selectedKeyOrNull === null ? [] : mergesPerDay(events, selectedKeyOrNull, CHART_DAYS, nowMs);
  const rows = selectedKeyOrNull === null ? [] : feedRows(events, selectedKeyOrNull, 200);
  const selectedRunning = selected !== undefined && selected.pid !== null;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b px-7 py-3.5">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="font-mono text-lg font-medium tracking-[-0.02em]">score</span>
        </div>
        <nav className="ml-3 flex gap-1" aria-label="views">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              aria-current={tab === name ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-[5px] text-[13.5px] capitalize",
                "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                tab === name
                  ? "border-input bg-secondary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-[18px] gap-y-2 text-[13px] text-muted-foreground">
          <span className="flex items-center gap-[7px]">
            <span
              className={cn(
                "size-[7px] rounded-full",
                running > 0 ? "bg-health-green" : "bg-health-gray",
              )}
            />
            {running} running
          </span>
          {down > 0 && (
            <span className="flex items-center gap-[7px]">
              <span className="size-[7px] rounded-full bg-health-red" />
              {down} down
            </span>
          )}
          <span className="font-mono">
            <span className="text-health-green">{mergedToday}</span> merged today
          </span>
        </div>
      </header>
      {troubled.map((project) => (
        <AlertBanner
          key={project.key}
          project={project}
          nowMs={nowMs}
          actionInFlight={actionInFlight}
          onRestart={() => act(project, "restart")}
          onViewJournal={() => {
            setTab("fleet");
            select(project.key);
            setDebug(true);
          }}
        />
      ))}

      {tab === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <HistoryPage events={events} projects={projects} nowMs={nowMs} />
        </div>
      ) : tab === "config" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConfigPage projects={projects} actionInFlight={actionInFlight} onAction={act} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ProjectRail
            projects={projects}
            statuses={statuses}
            selectedKey={selectedKey}
            onSelect={select}
          />
          {selected === undefined ? (
            <main className="flex min-w-0 flex-1 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">
                no projects — start the daemon first:{" "}
                <code className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono">score up</code>
              </p>
            </main>
          ) : (
            <>
              <main className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-[26px] py-[22px]">
                <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
                  <h1 className="text-[21px] font-semibold">{selected.key}</h1>
                  <p className="font-mono text-[13px] text-ink-dim">
                    {selected.resolved?.repo != null && (
                      <a
                        className="hover:text-muted-foreground"
                        href={`https://github.com/${selected.resolved.repo}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {selected.resolved.repo}
                      </a>
                    )}
                    {selected.resolved?.repo != null && " · "}
                    tick {selected.status?.tick ?? "-"} · {DOT_WORD[selected.dot]}
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionInFlight || (!selectedRunning && !selected.enabled)}
                      onClick={() => act(selected, selectedRunning ? "stop" : "start")}
                    >
                      {selectedRunning ? "Stop" : "Start"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={actionInFlight || !selected.enabled}
                      onClick={() => act(selected, "restart")}
                    >
                      Restart
                    </Button>
                  </div>
                </div>
                {selected.status?.last_gate_failure != null && (
                  <p
                    className="truncate text-[13px] text-health-amber"
                    title={selected.status.last_gate_failure}
                  >
                    gate: {selected.status.last_gate_failure}
                  </p>
                )}
                {stats !== null && (
                  <StatTiles
                    stats={[
                      // Live GitHub counts when the read works; the journal's
                      // derived numbers otherwise — labeled identically, since
                      // both answer the same question.
                      { label: "issues open", value: github === null ? "—" : github.openIssues },
                      {
                        label: "PRs open",
                        value: github === null ? stats.prsOpen : github.prs.length,
                        tone: "blue",
                      },
                      {
                        label: "stuck",
                        value: stats.stuck,
                        ...(stats.stuck > 0 ? { tone: "amber" as const } : {}),
                      },
                      { label: "merged · 24h", value: stats.merged24h, tone: "green" },
                      {
                        label: "issues blocked",
                        value: stats.issuesBlocked,
                        ...(stats.issuesBlocked > 0 ? { tone: "red" as const } : {}),
                      },
                    ]}
                  />
                )}
                <div className="flex flex-col gap-3 rounded-[10px] border border-card-border bg-card px-[18px] py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <p className="text-[13.5px] font-semibold whitespace-nowrap">Merges per day</p>
                    <p className="text-[12.5px] text-ink-dim">last {CHART_DAYS} days</p>
                  </div>
                  <MergeChart buckets={buckets} />
                </div>
                <ActivityPane
                  rows={rows}
                  live={live}
                  degraded={degraded}
                  journal={journal}
                  follow={follow}
                  onFollowChange={setFollow}
                  scrollTopNonce={scrollTopNonce}
                  debug={debug}
                  onDebugChange={setDebug}
                />
              </main>
              <PrPanel
                github={github}
                fold={fold}
                fallbackCards={cards}
                repo={selected.resolved?.repo ?? null}
                nowMs={nowMs}
              />
            </>
          )}
        </div>
      )}
      <footer className="flex h-8 shrink-0 items-center border-t px-4 font-mono text-[11px]">
        {pollError !== null ? (
          <p className="truncate text-health-red">error: {pollError}</p>
        ) : (
          <p className="ml-auto truncate text-ink-dim">{help ? HELP : SHORTCUTS}</p>
        )}
      </footer>
    </div>
  );
}
