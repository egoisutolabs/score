"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useFleet, useLogTail, useProjectAction } from "@/console/fleet.hooks";
import {
  DEFAULT_TICK_INTERVAL_MS,
  type ProjectAction,
  type ProjectViewJson,
} from "@/console/fleet-view.interface";
import { LogPane } from "@/console/log-pane";
import { ProjectPane } from "@/console/project-pane";
import { ProjectRail } from "@/console/project-rail";
import { TickPulse } from "@/console/tick-pulse";

const SHORTCUTS = "j/k select · x stop/start · r restart · f follow · g/G · ? help";
const HELP =
  "j/k select project · x stop/start via supervisor · r restart · f toggle follow · g top · G end — closing this tab never touches the fleet";

/**
 * The console, the TUI's layout web-native: rail left, selected project's
 * pane and live tail right, shortcut footer. Everything shown comes from the
 * v1 fleet API; every action goes through it; closing the tab only ever
 * closes the viewer.
 */
export function Console() {
  const { projects, pollError, refresh } = useFleet();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [scrollTopNonce, setScrollTopNonce] = useState(0);
  const [help, setHelp] = useState(false);
  const { actionInFlight, run } = useProjectAction(refresh);

  const selected = projects.find((project) => project.key === selectedKey);
  const tail = useLogTail(selected?.key ?? null);

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
        if (error !== null) toast.error(error);
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

      if (event.key === "j") moveTo(index + 1);
      else if (event.key === "k") moveTo(index - 1);
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

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b px-4">
        <p className="text-[13px] font-semibold tracking-[0.22em] lowercase">score</p>
        <TickPulse
          startedAt={selected?.status?.last_pass_started_at ?? null}
          intervalMs={selected?.resolved?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS}
        />
        <p className="ml-auto text-[13px]">
          <span className={running > 0 ? "text-health-green" : "text-health-gray"}>●</span>{" "}
          {running} running
        </p>
      </header>
      <div className="flex min-h-0 flex-1">
        <ProjectRail projects={projects} selectedKey={selectedKey} onSelect={select} />
        <main className="flex min-w-0 flex-1 flex-col">
          {selected === undefined ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">
                no projects — run:{" "}
                <code className="rounded-sm bg-secondary px-1.5 py-0.5">score up</code>
              </p>
            </div>
          ) : (
            <>
              <ProjectPane
                project={selected}
                actionInFlight={actionInFlight}
                onAction={(action) => act(selected, action)}
              />
              <LogPane
                file={tail.file}
                lines={tail.lines}
                follow={follow}
                onFollowChange={setFollow}
                scrollTopNonce={scrollTopNonce}
              />
            </>
          )}
        </main>
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
