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
  tiles,
} from "@/console/activity.policy";
import { ActivityPane } from "@/console/activity-pane";
import { AlertBanner, troubledProjects } from "@/console/alert-banner";
import { useFleet, useLogStream, useProjectAction } from "@/console/fleet.hooks";
import {
  DEFAULT_TICK_INTERVAL_MS,
  DOT_WORD,
  type ProjectAction,
  type ProjectViewJson,
} from "@/console/fleet-view.interface";
import { MergeChart } from "@/console/merge-chart";
import { PrPanel } from "@/console/pr-panel";
import { ProjectRail } from "@/console/project-rail";
import { StatTiles } from "@/console/stat-tiles";
import { TickPulse } from "@/console/tick-pulse";

const SHORTCUTS = "j/k select · x stop/start · r restart · f follow · g/G · ? help";
const HELP =
  "j/k select project · x stop/start via supervisor · r restart · f toggle follow (Debug tab) · g top · G end — closing this tab never touches the fleet";
const CHART_DAYS = 14;

/**
 * The fleet page: banners for troubled daemons, the selected project's
 * tiles/chart/activity in the middle, open PRs by trouble on the right.
 * Everything rendered is derived from the fleet poll and the decision-event
 * stream — no tile, card, or banner is ever synthesized from a guess.
 */
export function Console() {
  const { projects, pollError, refresh } = useFleet();
  const { events, live, degraded } = useEventStream(projects.map((project) => project.key));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [scrollTopNonce, setScrollTopNonce] = useState(0);
  const [help, setHelp] = useState(false);
  const [debug, setDebug] = useState(false);
  const { actionInFlight, run } = useProjectAction(refresh);
  // One coarse clock for every "Nm ago" on screen; ticks with the fleet poll.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  const selected = projects.find((project) => project.key === selectedKey);
  // The journal stream only runs while the Debug tab is showing.
  const journal = useLogStream(debug ? (selected?.key ?? null) : null, follow);

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
  }, [projects, selectedKey, selected, select, act]);

  const running = projects.filter((project) => project.pid !== null).length;
  const down = projects.filter((project) => project.dot === "red").length;
  const mergedToday = mergedTodayFleet(events, nowMs);
  const troubled = troubledProjects(projects);

  const selectedKeyOrNull = selected?.key ?? null;
  const stats = selectedKeyOrNull === null ? null : tiles(events, selectedKeyOrNull, nowMs);
  const cards = selectedKeyOrNull === null ? [] : openPrs(foldProject(events, selectedKeyOrNull));
  const buckets =
    selectedKeyOrNull === null ? [] : mergesPerDay(events, selectedKeyOrNull, CHART_DAYS, nowMs);
  const rows = selectedKeyOrNull === null ? [] : feedRows(events, selectedKeyOrNull, 200);
  const selectedRunning = selected !== undefined && selected.pid !== null;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b px-4">
        <p className="text-[13px] font-semibold tracking-[0.22em] lowercase">score</p>
        <TickPulse
          startedAt={selected?.status?.last_pass_started_at ?? null}
          intervalMs={selected?.resolved?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS}
        />
        <div className="ml-auto flex items-center gap-5 text-[13px]">
          <p>
            <span className={running > 0 ? "text-health-green" : "text-health-gray"}>●</span>{" "}
            {running} running
          </p>
          {down > 0 && (
            <p>
              <span className="text-health-red">●</span> {down} down
            </p>
          )}
          <p className="text-muted-foreground">
            <span className="text-foreground">{mergedToday}</span> merged today
          </p>
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
            select(project.key);
            setDebug(true);
          }}
        />
      ))}
      <div className="flex min-h-0 flex-1">
        <ProjectRail projects={projects} selectedKey={selectedKey} onSelect={select} />
        {selected === undefined ? (
          <main className="flex min-w-0 flex-1 items-center justify-center">
            <p className="text-[13px] text-muted-foreground">
              no projects — start the daemon first:{" "}
              <code className="rounded-sm bg-secondary px-1.5 py-0.5">score up</code>
            </p>
          </main>
        ) : (
          <>
            <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <h1 className="text-lg font-semibold tracking-tight">{selected.key}</h1>
                {selected.resolved?.repo != null && (
                  <a
                    className="text-[13px] text-muted-foreground underline-offset-2 hover:underline"
                    href={`https://github.com/${selected.resolved.repo}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {selected.resolved.repo} ↗
                  </a>
                )}
                <p className="text-[13px] text-muted-foreground">
                  tick {selected.status?.tick ?? "-"}
                </p>
                <p className="text-[13px] text-muted-foreground">{DOT_WORD[selected.dot]}</p>
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
                    { label: "prs open", value: stats.prsOpen },
                    {
                      label: "stuck",
                      value: stats.stuck,
                      ...(stats.stuck > 0 ? { tone: "red" as const } : {}),
                    },
                    { label: "merged · 24h", value: stats.merged24h },
                    {
                      label: "issues blocked",
                      value: stats.issuesBlocked,
                      ...(stats.issuesBlocked > 0 ? { tone: "amber" as const } : {}),
                    },
                    { label: "agent", value: selected.resolved?.agent.split(" ")[0] ?? "-" },
                  ]}
                />
              )}
              <div className="rounded-md border bg-card px-4 py-3">
                <div className="flex items-baseline gap-3">
                  <p className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                    merges per day
                  </p>
                  <p className="text-[11px] text-muted-foreground">last {CHART_DAYS} days</p>
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
            <PrPanel cards={cards} repo={selected.resolved?.repo ?? null} nowMs={nowMs} />
          </>
        )}
      </div>
      <footer className="flex h-8 shrink-0 items-center border-t px-4 text-[11px]">
        {pollError !== null ? (
          <p className="truncate text-health-red">error: {pollError}</p>
        ) : (
          <p className="ml-auto truncate text-muted-foreground">{help ? HELP : SHORTCUTS}</p>
        )}
      </footer>
    </div>
  );
}
