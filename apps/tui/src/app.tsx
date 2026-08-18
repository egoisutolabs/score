import {
  type SupervisorAdapter,
  supervisorForPlatform,
} from "@score/core/supervisor/supervisor-adapter.interface";
import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import { Box, type Key, render, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import type { Dot } from "./dots";
import { HistoryView } from "./history";
import type { ProjectView } from "./server-client.interface";
import { TuiServerClient } from "./server-client.service";
import { type TuiKey, TuiService, type TuiSnapshot } from "./tui.service";

const RAIL_WIDTH = 21;
const HEADER_HEIGHT = 1;
const PANE_HEADER_HEIGHT = 2;
const META_HEIGHT = 2;
const FOOTER_HEIGHT = 2;
const POLL_MS = 1000;
const LOG_CHROME = RAIL_WIDTH + 5;

// Palette lifted from Score Web.dc (1).html so the terminal and web reference
// share the same surfaces and operational accents.
const UI = {
  canvas: "#0b0e14",
  panel: "#0d1118",
  selected: "#161c26",
  border: "#1e2632",
  borderStrong: "#2e3a4c",
  text: "#dde3ea",
  textSoft: "#c3ccd8",
  muted: "#8a94a6",
  dim: "#5f6875",
  faint: "#4e5866",
  green: "#3ddc84",
  cyan: "#56d4dd",
  blue: "#5aa9ff",
  purple: "#c792ea",
  amber: "#ffb454",
  red: "#e06c6c",
  redSurface: "#150e11",
  redBorder: "#3a1e26",
} as const;

const DOT_CHAR: Record<Dot, string> = { green: "●", amber: "●", red: "●", gray: "○" };
const DOT_COLOR: Record<Dot, string> = {
  green: UI.green,
  amber: UI.amber,
  red: UI.red,
  gray: UI.faint,
};
const DOT_WORD: Record<Dot, string> = {
  green: "running",
  amber: "stale",
  red: "crashed",
  gray: "stopped",
};

export interface ScoreTuiProps {
  readonly service: TuiService;
  /** Fixed dimensions keep frame tests deterministic; production follows the terminal. */
  readonly columns?: number;
  readonly rows?: number;
}

function compactInterval(milliseconds: number): string {
  return milliseconds % 1000 === 0 ? `${milliseconds / 1000}s` : `${milliseconds}ms`;
}

function compactLogLine(line: string): string {
  const match = /^\[([^\]]+)] \[([^\]]+)] (.*)$/.exec(line);
  if (match === null) return line;
  const [, timestamp, level, body] = match;
  return `${timestamp?.slice(11, 19) ?? ""}  ${(level ?? "").padEnd(7)}  ${body ?? ""}`;
}

function logLevelColor(level: string): string {
  if (level === "error" || level === "fatal") return UI.red;
  if (level === "warn" || level === "warning") return UI.amber;
  if (level === "debug" || level === "trace") return UI.faint;
  return UI.cyan;
}

function inkKey(input: string, key: Key): TuiKey | null {
  if (key.escape) return { name: "escape" };
  if (key.tab) return { name: "tab" };
  if (key.pageDown) return { name: "pagedown" };
  if (key.pageUp) return { name: "pageup" };
  if (key.downArrow) return { name: "down" };
  if (key.upArrow) return { name: "up" };
  if (key.ctrl && (input === "c" || input === "\u0003")) return { name: "c", ctrl: true };
  if (input.length !== 1) return null;
  return { name: input.toLowerCase(), shift: key.shift || input !== input.toLowerCase() };
}

function useSnapshot(service: TuiService): TuiSnapshot {
  const [snapshot, setSnapshot] = useState(service.snapshot);
  useEffect(() => service.subscribe(() => setSnapshot(service.snapshot)), [service]);
  return snapshot;
}

function Header({
  views,
  view,
}: {
  readonly views: readonly ProjectView[];
  readonly view: TuiSnapshot["view"];
}) {
  const running = views.filter((view) => view.job?.pid !== undefined).length;
  const down = views.length - running;
  return (
    <Box
      height={HEADER_HEIGHT}
      flexShrink={0}
      paddingX={2}
      alignItems="center"
      justifyContent="space-between"
      backgroundColor={UI.panel}
    >
      <Text wrap="truncate-end">
        <Text color={UI.green}>■</Text>{" "}
        <Text bold color={UI.text}>
          score
        </Text>
        <Text color={UI.dim}>{"   "}</Text>
        <Text color={view === "overview" ? UI.text : UI.dim}>1 OVERVIEW</Text>
        <Text color={UI.borderStrong}>{"   "}</Text>
        <Text color={view === "history" ? UI.text : UI.dim}>2 HISTORY</Text>
      </Text>
      <Text wrap="truncate-start">
        <Text color={UI.green}>●</Text>
        <Text color={UI.muted}>{` ${running} running  `}</Text>
        <Text color={down === 0 ? UI.faint : UI.red}>●</Text>
        <Text color={UI.muted}>{` ${down} down`}</Text>
      </Text>
    </Box>
  );
}

function ProjectCard({
  view,
  selected,
}: {
  readonly view: ProjectView;
  readonly selected: boolean;
}) {
  const alert = view.dot === "red";
  const tick = `t${view.status?.tick ?? "-"}`;
  const status = [DOT_WORD[view.dot], ...(view.enabled ? [] : ["disabled"])].join(" · ");
  return (
    <Box
      width="100%"
      height={3}
      paddingX={1}
      flexDirection="column"
      backgroundColor={alert ? UI.redSurface : selected ? UI.selected : UI.canvas}
    >
      <Box justifyContent="space-between">
        <Text color={selected ? UI.green : UI.dim}>{selected ? "▌" : " "} </Text>
        <Text color={selected ? UI.text : UI.textSoft} bold={selected} wrap="truncate-end">
          {view.key}
        </Text>
        <Box flexGrow={1} />
        <Text color={UI.faint}>{tick}</Text>
      </Box>
      <Box>
        <Text color={DOT_COLOR[view.dot]}>
          {`  ${DOT_CHAR[view.dot]} `}
          <Text color={alert ? UI.red : UI.muted}>{status}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function ProjectRail({
  snapshot,
  rows,
}: {
  readonly snapshot: TuiSnapshot;
  readonly rows: number;
}) {
  const selectedIndex = Math.max(
    0,
    snapshot.views.findIndex((view) => view.key === snapshot.selectedKey),
  );
  const capacity = Math.max(1, Math.floor((rows - HEADER_HEIGHT - FOOTER_HEIGHT - 2) / 3));
  const start = Math.min(
    Math.max(0, snapshot.views.length - capacity),
    Math.max(0, selectedIndex - capacity + 1),
  );
  const visible = snapshot.views.slice(start, start + capacity);
  const position =
    snapshot.views.length > capacity ? ` · ${selectedIndex + 1}/${snapshot.views.length}` : "";
  return (
    <Box
      width={RAIL_WIDTH}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      paddingTop={1}
      backgroundColor={UI.panel}
    >
      <Box paddingX={1} height={2}>
        <Text color={UI.dim}>
          PROJECTS <Text color={UI.faint}>{snapshot.views.length + position}</Text>
        </Text>
      </Box>
      {visible.length === 0 ? <Text color={UI.faint}> no projects</Text> : null}
      {visible.map((view) => (
        <ProjectCard key={view.key} view={view} selected={view.key === snapshot.selectedKey} />
      ))}
    </Box>
  );
}

function Metadata({ selected }: { readonly selected: ProjectView | undefined }) {
  const interval =
    selected?.resolved === null || selected === undefined
      ? "—"
      : compactInterval(selected.resolved.tickIntervalMs);
  return (
    <Box
      height={META_HEIGHT}
      flexShrink={0}
      alignItems="center"
      justifyContent="space-between"
      overflow="hidden"
    >
      <Text wrap="truncate-end">
        <Text color={UI.dim}>AGENT </Text>
        <Text color={UI.cyan}>{selected?.resolved?.agent ?? "—"}</Text>
      </Text>
      <Text wrap="truncate-start">
        <Text color={UI.textSoft}>{interval}</Text>
        <Text color={UI.dim}> tick</Text>
        <Text color={UI.borderStrong}>{"  ·  "}</Text>
        <Text color={UI.textSoft}>{String(selected?.resolved?.maxParallel ?? "—")}</Text>
        <Text color={UI.dim}> parallel</Text>
      </Text>
    </Box>
  );
}

function PaneHeader({ selected }: { readonly selected: ProjectView | undefined }) {
  if (selected === undefined) {
    return (
      <Box height={PANE_HEADER_HEIGHT} paddingLeft={1} alignItems="center">
        <Text color={UI.text}>fleet is empty</Text>
        <Text color={UI.dim}> run score up to add a project</Text>
      </Box>
    );
  }
  const suffix = [
    ...(selected.job?.pid !== undefined ? [`pid ${selected.job.pid}`] : []),
    ...(selected.enabled ? [] : ["disabled"]),
  ].join(" · ");
  const action = selected.job?.pid !== undefined ? "stop" : "start";
  return (
    <Box height={PANE_HEADER_HEIGHT} alignItems="center" justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text bold color={UI.text}>
          {selected.key}
        </Text>
        <Text color={UI.faint}>{` / tick ${selected.status?.tick ?? "-"}`}</Text>
      </Text>
      <Text wrap="truncate-start">
        <Text color={DOT_COLOR[selected.dot]}>
          {DOT_CHAR[selected.dot]} {DOT_WORD[selected.dot]}
        </Text>
        <Text color={UI.dim}>{suffix === "" ? "" : ` · ${suffix}`}</Text>
        <Text color={UI.muted}>{`   x ${action}`}</Text>
      </Text>
    </Box>
  );
}

function LogRow({ row }: { readonly row: string }) {
  const match = /^(\d{2}:\d{2}:\d{2}) {2}(\S+)\s{2,}(.*)$/.exec(row);
  if (match === null) return <Text color={UI.muted}>{row}</Text>;
  return (
    <Text>
      <Text color={UI.faint}>{match[1]}</Text>
      <Text color={UI.borderStrong}>{"  "}</Text>
      <Text color={logLevelColor(match[2] ?? "")}>{(match[2] ?? "").padEnd(7)}</Text>
      <Text color={UI.muted}>{`  ${match[3]}`}</Text>
    </Text>
  );
}

function Activity({
  snapshot,
  columns,
  rows,
  copyMode = false,
}: {
  readonly snapshot: TuiSnapshot;
  readonly columns: number;
  readonly rows: number;
  readonly copyMode?: boolean;
}) {
  const wrapWidth = Math.max(20, columns - (copyMode ? 4 : LOG_CHROME));
  const sourceRows =
    snapshot.selectedKey === null ? [] : (snapshot.logs.get(snapshot.selectedKey) ?? []);
  const logStart = Math.min(snapshot.logStart, Math.max(0, sourceRows.length - 1));
  const allRows = (snapshot.follow ? sourceRows : sourceRows.slice(logStart)).flatMap((source) => {
    const line = compactLogLine(source);
    const chunks = [line.slice(0, wrapWidth)];
    for (let at = wrapWidth; at < line.length; at += wrapWidth - 2) {
      chunks.push(`  ${line.slice(at, at + wrapWidth - 2)}`);
    }
    return chunks;
  });
  const available = Math.max(
    1,
    rows - HEADER_HEIGHT - FOOTER_HEIGHT - (copyMode ? 4 : PANE_HEADER_HEIGHT + META_HEIGHT + 4),
  );
  const start = snapshot.follow ? Math.max(0, allRows.length - available) : 0;
  const visible = allRows.slice(start, start + available).map((row, offset) => ({
    id: `${start + offset}:${row}`,
    row,
  }));
  return (
    <Box flexGrow={1} minHeight={3} overflow="hidden" flexDirection="column">
      <Box height={2} justifyContent="space-between" flexShrink={0} alignItems="center">
        <Text color={UI.textSoft} bold wrap="truncate-end">
          ACTIVITY
          <Text color={UI.faint}>{snapshot.logFile === "" ? "" : ` / ${snapshot.logFile}`}</Text>
        </Text>
        <Text color={snapshot.follow ? UI.green : UI.faint}>
          {snapshot.follow
            ? "● LIVE"
            : `PAUSED ${sourceRows.length === 0 ? 0 : logStart + 1}/${sourceRows.length}`}
        </Text>
      </Box>
      {visible.map((line) => (
        <LogRow key={line.id} row={line.row} />
      ))}
    </Box>
  );
}

function Footer({
  snapshot,
  selected,
}: {
  readonly snapshot: TuiSnapshot;
  readonly selected: ProjectView | undefined;
}) {
  const error = snapshot.actionError ?? snapshot.pollError;
  return (
    <Box
      height={FOOTER_HEIGHT}
      flexShrink={0}
      paddingX={2}
      flexDirection="column"
      backgroundColor={UI.panel}
    >
      {error !== null ? (
        <Text color={snapshot.actionError === null ? UI.amber : UI.red} wrap="truncate-end">
          ● {snapshot.actionError === null ? "warning" : "error"}: {error}
        </Text>
      ) : (
        <Text> </Text>
      )}
      {snapshot.view === "history" ? (
        <Text color={UI.dim} wrap="truncate-end">
          <Text color={UI.textSoft}>1</Text>
          {" overview  "}
          <Text color={UI.textSoft}>2</Text>
          {" history  "}
          <Text color={snapshot.historyDays === 7 ? UI.textSoft : UI.faint}>7</Text>
          {" 7d  "}
          <Text color={snapshot.historyDays === 30 ? UI.textSoft : UI.faint}>3</Text>
          {" 30d  Tab switch  q quit"}
        </Text>
      ) : snapshot.help ? (
        <Text wrap="truncate-end">
          <Text color={UI.textSoft}>j/k</Text>
          <Text color={UI.dim}>{" project   "}</Text>
          <Text color={UI.textSoft}>x</Text>
          <Text color={UI.dim}>{" start/stop   "}</Text>
          <Text color={UI.textSoft}>r</Text>
          <Text color={UI.dim}>{" restart   "}</Text>
          <Text color={UI.textSoft}>f</Text>
          <Text color={UI.dim}>{" follow   "}</Text>
          <Text color={UI.textSoft}>g/G</Text>
          <Text color={UI.dim}>{" top/end   "}</Text>
          <Text color={UI.textSoft}>c</Text>
          <Text color={UI.dim}>{" copy view   "}</Text>
          <Text color={UI.textSoft}>q</Text>
          <Text color={UI.dim}>{" quit viewer"}</Text>
        </Text>
      ) : snapshot.copyMode ? (
        <Text color={UI.dim} wrap="truncate-end">
          <Text color={UI.cyan}>COPY VIEW</Text>
          {"  highlight logs normally  Esc/c back  u/d scroll  g/G ends  q quit"}
        </Text>
      ) : (
        <Text color={UI.dim} wrap="truncate-end">
          {"j/k project  u/d scroll  g/G ends  f "}
          <Text color={snapshot.follow ? UI.green : UI.faint}>
            {snapshot.follow ? "on" : "off"}
          </Text>
          {"  x "}
          <Text color={UI.textSoft}>{selected?.job?.pid !== undefined ? "stop" : "start"}</Text>
          {"  r restart  c copy  q quit"}
        </Text>
      )}
    </Box>
  );
}

/** Ink view over server-owned read models and supervisor-owned lifecycle actions. */
export function ScoreTui({ service, columns: fixedColumns, rows: fixedRows }: ScoreTuiProps) {
  const window = useWindowSize();
  const columns = fixedColumns ?? window.columns;
  const rows = fixedRows ?? window.rows;
  const snapshot = useSnapshot(service);
  const { exit } = useApp();
  useEffect(() => {
    void service.refresh();
    const interval = setInterval(() => void service.refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [service]);
  useInput((input, key) => {
    const mapped = inkKey(input, key);
    if (mapped !== null && service.handleKey(mapped)) exit();
  });

  const selected = snapshot.views.find((view) => view.key === snapshot.selectedKey);
  return (
    <Box
      width={columns}
      height={rows}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={UI.canvas}
    >
      <Header views={snapshot.views} view={snapshot.view} />
      {snapshot.view === "history" ? (
        <HistoryView
          events={snapshot.history}
          githubMerges={snapshot.githubMerges}
          projects={snapshot.views.map((view) => view.key)}
          day={snapshot.logFile.slice(0, 10) || new Date().toISOString().slice(0, 10)}
          days={snapshot.historyDays}
          rows={rows}
          colors={UI}
        />
      ) : snapshot.copyMode ? (
        <Box
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          paddingX={2}
          paddingTop={1}
          flexDirection="column"
          overflow="hidden"
          backgroundColor={UI.canvas}
        >
          <Activity snapshot={snapshot} columns={columns} rows={rows} copyMode />
        </Box>
      ) : (
        <Box flexGrow={1} minHeight={0} flexDirection="row" overflow="hidden">
          <ProjectRail snapshot={snapshot} rows={rows} />
          <Box
            flexGrow={1}
            minWidth={0}
            paddingLeft={2}
            paddingRight={1}
            paddingTop={1}
            flexDirection="column"
            overflow="hidden"
            backgroundColor={UI.canvas}
          >
            <PaneHeader selected={selected} />
            <Metadata selected={selected} />
            <Activity snapshot={snapshot} columns={columns} rows={rows} />
          </Box>
        </Box>
      )}
      <Footer snapshot={snapshot} selected={selected} />
    </Box>
  );
}

export async function runTui(args: readonly string[]): Promise<void> {
  if (args.length > 0) throw new Error("usage: score tui");
  const adapter: SupervisorAdapter = supervisorForPlatform(new BunCommandRunner()).adapter;
  const service = new TuiService({
    adapter,
    data: new TuiServerClient(process.env.SCORE_SERVER_URL),
  });
  const app = render(<ScoreTui service={service} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: true,
  });
  await app.waitUntilExit();
}
