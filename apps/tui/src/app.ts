import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  fg,
  type KeyEvent,
  StyledText,
  TextRenderable,
  t,
} from "@opentui/core";
import {
  type SupervisorAdapter,
  supervisorForPlatform,
} from "@score/core/supervisor/supervisor-adapter.interface";
import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import { restartProject, startProject, stopProject } from "@score/tui/actions";
import type { Dot } from "@score/tui/dots";
import type { ProjectView, TuiDataSource } from "@score/tui/server-client.interface";
import { TuiServerClient } from "@score/tui/server-client.service";

const RAIL_WIDTH = 24;
const HEADER_HEIGHT = 3;
const PANE_HEADER_HEIGHT = 2;
const STATS_HEIGHT = 4;
const FOOTER_HEIGHT = 2;
const POLL_MS = 1000;
/** Rail and pane chrome removed from the activity row width. */
const LOG_CHROME = RAIL_WIDTH + 6;

// Palette lifted from Score Web.dc (1).html. Terminal layout is denser, but
// sharing the same surfaces and status accents keeps both views recognizably Score.
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

function compactInterval(milliseconds: number): string {
  return milliseconds % 1000 === 0 ? `${milliseconds / 1000}s` : `${milliseconds}ms`;
}

function compactLogLine(line: string): string {
  const match = /^\[([^\]]+)] \[([^\]]+)] (.*)$/.exec(line);
  if (match === null) return line;
  const [, timestamp, level, body] = match;
  const time = timestamp?.slice(11, 19) ?? "";
  return `${time}  ${(level ?? "").padEnd(7)}  ${body ?? ""}`;
}

function logLevelColor(level: string): string {
  if (level === "error" || level === "fatal") return UI.red;
  if (level === "warn" || level === "warning") return UI.amber;
  if (level === "debug" || level === "trace") return UI.faint;
  return UI.cyan;
}

function styledLogRows(rows: readonly string[]): StyledText {
  const chunks = rows.flatMap((row, index) => {
    const match = /^(\d{2}:\d{2}:\d{2}) {2}(\S+)\s{2,}(.*)$/.exec(row);
    const line =
      match === null
        ? [fg(UI.muted)(row)]
        : [
            fg(UI.faint)(match[1] ?? ""),
            fg(UI.borderStrong)("  "),
            fg(logLevelColor(match[2] ?? ""))((match[2] ?? "").padEnd(7)),
            fg(UI.muted)(`  ${match[3] ?? ""}`),
          ];
    return index === rows.length - 1 ? line : [...line, fg(UI.muted)("\n")];
  });
  return new StyledText(chunks);
}

export interface TuiDeps {
  readonly adapter: SupervisorAdapter;
  readonly data: TuiDataSource;
}

export interface TuiKey {
  readonly name: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
}

export interface TuiApp {
  /** One API poll cycle: fleet snapshot + new log records + render. */
  refresh(): Promise<void>;
  handleKey(key: TuiKey): void;
  /** Resolves when the user quits the viewer. */
  readonly done: Promise<void>;
}

/**
 * Score Web.dc (1).html supplies the visual system: compact fleet rail, dark
 * cards, muted chrome, and bright operational accents. Everything rendered
 * still comes from the server's read-only SSE API; every action goes through
 * the supervisor adapter, and quitting only ever exits the viewer.
 */
export function buildTui(renderer: CliRenderer, deps: TuiDeps): TuiApp {
  let views: ProjectView[] = [];
  let selectedKey: string | null = null;
  let logs: ReadonlyMap<string, readonly string[]> = new Map();
  let logFile = "";
  let follow = true;
  let scroll = 0;
  let help = false;
  let actionInFlight = false;
  let actionError: string | null = null;
  let pollError: string | null = null;
  let refreshing = false;

  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const headerText = new TextRenderable(renderer, {
    id: "header-text",
    content: "",
    truncate: true,
  });
  const headerBox = new BoxRenderable(renderer, {
    id: "header",
    border: ["bottom"],
    borderColor: UI.border,
    backgroundColor: UI.canvas,
    width: "100%",
    height: HEADER_HEIGHT,
    paddingX: 2,
    justifyContent: "center",
  });
  headerBox.add(headerText);
  const railBox = new BoxRenderable(renderer, {
    id: "rail",
    border: ["right"],
    borderColor: UI.border,
    backgroundColor: UI.canvas,
    width: RAIL_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
    paddingX: 1,
    paddingTop: 1,
  });
  const railTitle = new TextRenderable(renderer, {
    id: "rail-title",
    content: "",
    fg: UI.dim,
    height: 1,
  });
  const railEmpty = new TextRenderable(renderer, {
    id: "rail-empty",
    content: "no projects",
    fg: UI.faint,
    height: 1,
  });
  railBox.add(railTitle);
  railBox.add(railEmpty);
  const railCards: Array<{ box: BoxRenderable; text: TextRenderable }> = [];

  const paneHeaderText = new TextRenderable(renderer, {
    id: "pane-header-text",
    content: "",
    truncate: true,
  });
  const paneHeaderBox = new BoxRenderable(renderer, {
    id: "pane-header",
    height: PANE_HEADER_HEIGHT,
    paddingLeft: 1,
    justifyContent: "center",
  });
  paneHeaderBox.add(paneHeaderText);

  const metricBox = (id: string, grow: number): [BoxRenderable, TextRenderable] => {
    const text = new TextRenderable(renderer, {
      id: `${id}-text`,
      content: "",
      truncate: true,
      wrapMode: "none",
    });
    const box = new BoxRenderable(renderer, {
      id,
      flexGrow: grow,
      flexBasis: 0,
      height: STATS_HEIGHT,
      border: true,
      borderStyle: "rounded",
      borderColor: UI.border,
      backgroundColor: UI.panel,
      paddingLeft: 1,
    });
    box.add(text);
    return [box, text];
  };
  const [agentBox, agentText] = metricBox("agent", 2);
  const [tickBox, tickText] = metricBox("tick", 1);
  const [parallelBox, parallelText] = metricBox("parallel", 1);
  const statsRow = new BoxRenderable(renderer, {
    id: "stats",
    height: STATS_HEIGHT,
    width: "100%",
    flexDirection: "row",
    columnGap: 1,
  });
  statsRow.add(agentBox);
  statsRow.add(tickBox);
  statsRow.add(parallelBox);

  // Lines are wrapped by hand so scroll positions remain stable across polls.
  const logText = new TextRenderable(renderer, {
    id: "log-text",
    content: "",
    wrapMode: "none",
  });
  const logBox = new BoxRenderable(renderer, {
    id: "log",
    title: "activity",
    border: true,
    borderStyle: "rounded",
    borderColor: UI.border,
    titleColor: UI.textSoft,
    backgroundColor: UI.panel,
    flexGrow: 1,
    paddingX: 1,
    bottomTitleAlignment: "right",
  });
  logBox.add(logText);
  const rightColumn = new BoxRenderable(renderer, {
    id: "right",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: UI.canvas,
    padding: 1,
    rowGap: 1,
  });
  rightColumn.add(paneHeaderBox);
  rightColumn.add(statsRow);
  rightColumn.add(logBox);
  const mainRow = new BoxRenderable(renderer, {
    id: "main",
    flexGrow: 1,
    width: "100%",
    flexDirection: "row",
  });
  mainRow.add(railBox);
  mainRow.add(rightColumn);
  const footerText = new TextRenderable(renderer, { id: "footer-text", content: "" });
  const footerBox = new BoxRenderable(renderer, {
    id: "footer",
    border: ["top"],
    borderColor: UI.border,
    backgroundColor: UI.canvas,
    width: "100%",
    height: FOOTER_HEIGHT,
    paddingX: 2,
  });
  footerBox.add(footerText);
  const root = new BoxRenderable(renderer, {
    id: "tui-root",
    backgroundColor: UI.canvas,
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  root.add(headerBox);
  root.add(mainRow);
  root.add(footerBox);
  renderer.root.add(root);

  const selectedView = (): ProjectView | undefined =>
    views.find((view) => view.key === selectedKey);

  const render = (): void => {
    // An in-flight API poll can land after quit tore the renderer down.
    if (renderer.isDestroyed) return;

    const running = views.filter((view) => view.job?.pid !== undefined).length;
    const down = views.length - running;
    const headerLeft = "■ score  FLEET";
    const headerRight = `● ${running} running  ● ${down} down`;
    const headerPad = Math.max(
      1,
      renderer.terminalWidth - 4 - headerLeft.length - headerRight.length,
    );
    headerText.content = t`${fg(UI.green)("■")} ${fg(UI.text)("score")}  ${fg(UI.dim)("FLEET")}${" ".repeat(headerPad)}${fg(UI.green)("●")} ${fg(UI.muted)(`${running} running`)}  ${fg(down === 0 ? UI.faint : UI.red)("●")} ${fg(UI.muted)(`${down} down`)}`;

    railTitle.content = t`${fg(UI.dim)("PROJECTS")} ${fg(UI.faint)(views.length)}`;
    railEmpty.visible = views.length === 0;
    while (railCards.length < views.length) {
      const index = railCards.length;
      const text = new TextRenderable(renderer, {
        id: `project-card-${index}-text`,
        content: "",
        wrapMode: "none",
        truncate: true,
      });
      const box = new BoxRenderable(renderer, {
        id: `project-card-${index}`,
        width: "100%",
        height: 4,
        border: true,
        borderStyle: "rounded",
        borderColor: UI.canvas,
        backgroundColor: UI.canvas,
        paddingLeft: 1,
      });
      box.add(text);
      railBox.add(box);
      railCards.push({ box, text });
    }
    railCards.forEach(({ box, text }, index) => {
      const view = views[index];
      if (view === undefined) {
        box.visible = false;
        return;
      }
      box.visible = true;
      const selected = view.key === selectedKey;
      const alert = view.dot === "red";
      box.backgroundColor = alert ? UI.redSurface : selected ? UI.selected : UI.canvas;
      box.borderColor = alert ? UI.redBorder : selected ? UI.borderStrong : UI.canvas;
      const tick = `t${view.status?.tick ?? "-"}`;
      const cardWidth = RAIL_WIDTH - 6;
      const name = view.key.slice(0, Math.max(1, cardWidth - tick.length - 3));
      const pad = Math.max(1, cardWidth - name.length - tick.length - 2);
      const status = [
        DOT_WORD[view.dot],
        ...(view.job?.pid !== undefined ? [`pid ${view.job.pid}`] : []),
        ...(view.enabled ? [] : ["disabled"]),
      ].join(" · ");
      text.content = t`${fg(DOT_COLOR[view.dot])(DOT_CHAR[view.dot])} ${fg(selected ? UI.text : UI.textSoft)(name)}${" ".repeat(pad)}${fg(UI.faint)(tick)}\n ${fg(DOT_COLOR[view.dot])(status.slice(0, cardWidth - 1))}`;
    });

    const selected = selectedView();
    if (selected === undefined) {
      paneHeaderText.content = t`${fg(UI.text)("fleet is empty")}  ${fg(UI.dim)("run score up to add a project")}`;
      agentText.content = t`${fg(UI.dim)("AGENT")}\n${fg(UI.faint)("—")}`;
      tickText.content = t`${fg(UI.dim)("TICK")}\n${fg(UI.faint)("—")}`;
      parallelText.content = t`${fg(UI.dim)("PARALLEL")}\n${fg(UI.faint)("—")}`;
    } else {
      const tick = `t${selected.status?.tick ?? "-"}`;
      const action = selected.job?.pid !== undefined ? "stop" : "start";
      const stateSuffix = [
        ...(selected.job?.pid !== undefined ? [`pid ${selected.job.pid}`] : []),
        ...(selected.enabled ? [] : ["disabled"]),
      ].join(" · ");
      const headerPlainLeft = `${selected.key}  ${tick}`;
      const headerPlainRight = `● ${DOT_WORD[selected.dot]}${stateSuffix === "" ? "" : ` · ${stateSuffix}`}  [x] ${action}`;
      const paneWidth = renderer.terminalWidth - RAIL_WIDTH - 4;
      const pad = Math.max(1, paneWidth - headerPlainLeft.length - headerPlainRight.length);
      paneHeaderText.content = t`${fg(UI.text)(selected.key)}  ${fg(UI.faint)(tick)}${" ".repeat(pad)}${fg(DOT_COLOR[selected.dot])(DOT_CHAR[selected.dot])} ${fg(DOT_COLOR[selected.dot])(DOT_WORD[selected.dot])}${fg(UI.dim)(stateSuffix === "" ? "" : ` · ${stateSuffix}`)}  ${fg(UI.muted)(`[x] ${action}`)}`;
      agentText.content = t`${fg(UI.dim)("AGENT")}\n${fg(UI.cyan)(selected.resolved?.agent ?? "not resolved")}`;
      tickText.content = t`${fg(UI.dim)("TICK")}\n${fg(UI.text)(selected.resolved === null ? "—" : compactInterval(selected.resolved.tickIntervalMs))}`;
      parallelText.content = t`${fg(UI.dim)("PARALLEL")}\n${fg(UI.text)(selected.resolved?.maxParallel ?? "—")}`;
    }

    const wrapWidth = Math.max(20, renderer.terminalWidth - LOG_CHROME);
    const rows = (selectedKey === null ? [] : (logs.get(selectedKey) ?? [])).flatMap((source) => {
      const line = compactLogLine(source);
      const chunks: string[] = [];
      chunks.push(line.slice(0, wrapWidth));
      for (let at = wrapWidth; at < line.length; at += wrapWidth - 2) {
        chunks.push(`  ${line.slice(at, at + wrapWidth - 2)}`);
      }
      return chunks;
    });
    const visible = Math.max(
      1,
      renderer.terminalHeight -
        HEADER_HEIGHT -
        PANE_HEADER_HEIGHT -
        STATS_HEIGHT -
        FOOTER_HEIGHT -
        6,
    );
    const maxStart = Math.max(0, rows.length - visible);
    scroll = follow ? maxStart : Math.min(scroll, maxStart);
    logText.content = styledLogRows(rows.slice(scroll, scroll + visible));
    logBox.title = logFile === "" ? "activity" : `activity · ${logFile}`;
    logBox.bottomTitle = follow ? "● live" : "paused";

    const error = actionError ?? pollError;
    if (error !== null) {
      const label = actionError === null ? "warning" : "error";
      footerText.content = t`${fg(actionError === null ? UI.amber : UI.red)("●")} ${fg(UI.textSoft)(`${label}: ${error}`)}`;
    } else if (help) {
      footerText.content = t`${fg(UI.textSoft)("j/k")} ${fg(UI.dim)("project   ")}${fg(UI.textSoft)("x")} ${fg(UI.dim)("start/stop   ")}${fg(UI.textSoft)("r")} ${fg(UI.dim)("restart   ")}${fg(UI.textSoft)("f")} ${fg(UI.dim)("follow   ")}${fg(UI.textSoft)("g/G")} ${fg(UI.dim)("top/end   ")}${fg(UI.textSoft)("q")} ${fg(UI.dim)("quit viewer")}`;
    } else {
      footerText.content = t`${fg(UI.dim)("j/k project   x ")}${fg(UI.textSoft)(selected?.job?.pid !== undefined ? "stop" : "start")}${fg(UI.dim)("   r restart   f follow ")}${fg(follow ? UI.green : UI.faint)(follow ? "on" : "off")}${fg(UI.dim)("   g/G logs   ? help   q quit")}`;
    }
  };

  const select = (key: string | null): void => {
    if (key === selectedKey) return;
    selectedKey = key;
    follow = true;
    scroll = 0;
  };

  const move = (delta: number): void => {
    if (views.length === 0) return;
    const index = views.findIndex((view) => view.key === selectedKey) + delta;
    select(views[Math.max(0, Math.min(views.length - 1, index))]?.key ?? null);
    render();
  };

  const runAction = (action: (adapter: SupervisorAdapter, key: string) => Promise<void>): void => {
    const view = selectedView();
    // One action at a time — a failing supervisor must not turn into a retry storm.
    if (view === undefined || actionInFlight) return;
    actionInFlight = true;
    actionError = null;
    action(deps.adapter, view.key)
      .catch((error: unknown) => {
        actionError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        actionInFlight = false;
        // No optimistic state: the next status poll reflects reality.
        render();
      });
  };

  const handleKey = (key: TuiKey): void => {
    // Quit exits the viewer only — it must never reach the adapter.
    if (key.name === "q" || (key.ctrl === true && key.name === "c")) {
      finish();
      return;
    }
    if (key.name === "j" || key.name === "down") move(1);
    else if (key.name === "k" || key.name === "up") move(-1);
    else if (key.name === "g" && key.shift === true) follow = true;
    else if (key.name === "g") {
      follow = false;
      scroll = 0;
    } else if (key.name === "f") follow = !follow;
    else if (key.name === "?") help = !help;
    else if (key.name === "x") {
      const view = selectedView();
      if (view?.job?.pid !== undefined) runAction(stopProject);
      else if (view !== undefined && !view.enabled) {
        // The viewer honors the same disabled-project contract as `score up`:
        // stopping a running disabled job is fine, starting one is not.
        actionError = `'${view.key}' is disabled in config — not starting`;
      } else {
        // A crashed job is still registered with the supervisor: start alone.
        // A booted-out or definition-only job needs install-then-start.
        const registered = view?.job?.loaded === true;
        runAction((adapter, projectKey) => startProject(adapter, projectKey, registered));
      }
    } else if (key.name === "r") {
      const view = selectedView();
      if (view !== undefined && !view.enabled) {
        actionError = `'${view.key}' is disabled in config — not starting`;
      } else runAction(restartProject);
    } else return;
    render();
  };

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      try {
        const state = await deps.data.poll();
        views = [...state.projects];
        logs = state.logs;
        logFile = state.logFile;
        pollError = state.warnings.length === 0 ? null : state.warnings.join(", ");
      } catch (error) {
        pollError = error instanceof Error ? error.message : String(error);
      }
      if (selectedKey === null || !views.some((view) => view.key === selectedKey)) {
        select(views[0]?.key ?? null);
      }
      render();
    } finally {
      refreshing = false;
    }
  };

  return { refresh, handleKey, done };
}

export async function runTui(args: readonly string[]): Promise<void> {
  if (args.length > 0) throw new Error("usage: score tui");
  const adapter: SupervisorAdapter = supervisorForPlatform(new BunCommandRunner()).adapter;
  const data = new TuiServerClient(process.env.SCORE_SERVER_URL);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const app = buildTui(renderer, { adapter, data });
  renderer.keyInput.on("keypress", (key: KeyEvent) => app.handleKey(key));
  await app.refresh();
  const interval = setInterval(() => void app.refresh(), POLL_MS);
  try {
    await app.done;
  } finally {
    clearInterval(interval);
    renderer.destroy();
  }
}
