import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  fg,
  type KeyEvent,
  TextRenderable,
  t,
} from "@opentui/core";
import { BunCommandRunner } from "@/adapters/command-runner";
import { logsDir } from "@/features/config/layout";
import { loadConfig } from "@/features/config/load";
import type { ScoreConfig } from "@/features/config/model";
import { type SupervisorAdapter, supervisorForPlatform } from "@/features/supervisor/adapter";
import { restartProject, startProject, stopProject } from "@/features/tui/actions";
import type { Dot } from "@/features/tui/dots";
import { fleetSnapshot, type ProjectView } from "@/features/tui/snapshot";
import { LogTail } from "@/features/tui/tail";

const RAIL_WIDTH = 26;
const HEADER_HEIGHT = 3;
const PANE_HEADER_HEIGHT = 1;
const CONFIG_HEIGHT = 6;
const FOOTER_HEIGHT = 1;
const POLL_MS = 1000;
/** Rail border (2) — the card content area inside the projects box. */
const RAIL_INNER = RAIL_WIDTH - 2;
/** Rail (26) + log box border (2) + paddingLeft (1) — the wrap width for log rows. */
const LOG_CHROME = RAIL_WIDTH + 3;

const DOT_CHAR: Record<Dot, string> = { green: "●", amber: "●", red: "●", gray: "○" };
const DOT_COLOR: Record<Dot, string> = {
  green: "#3fb950",
  amber: "#d29922",
  red: "#f85149",
  gray: "#8b949e",
};
const DOT_WORD: Record<Dot, string> = {
  green: "running",
  amber: "stale",
  red: "error",
  gray: "stopped",
};

export interface TuiDeps {
  readonly adapter: SupervisorAdapter;
  readonly config: ScoreConfig;
  readonly now?: () => Date;
}

export interface TuiKey {
  readonly name: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
}

export interface TuiApp {
  /** One poll cycle: fleet snapshot + log tail + render. */
  refresh(): Promise<void>;
  handleKey(key: TuiKey): void;
  /** Resolves when the user quits the viewer. */
  readonly done: Promise<void>;
}

/**
 * The viewer per docs/wireframe_tui.png: project rail with live dots and the
 * latest tick on the left; the selected project's config box, log tail, and a
 * shortcut footer on the right. Everything rendered comes from status.json,
 * resolved.json, dated logs, and adapter.status(); every action goes through
 * the adapter; quitting only ever exits the viewer.
 */
export function buildTui(renderer: CliRenderer, deps: TuiDeps): TuiApp {
  const now = deps.now ?? (() => new Date());

  let views: ProjectView[] = [];
  let selectedKey: string | null = null;
  let tail: LogTail | null = null;
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

  // Top header bar per the wireframe: app name left, fleet summary right.
  const headerText = new TextRenderable(renderer, { id: "header-text", content: "" });
  const headerBox = new BoxRenderable(renderer, {
    id: "header",
    border: true,
    width: "100%",
    height: HEADER_HEIGHT,
    paddingLeft: 1,
  });
  headerBox.add(headerText);
  const railBox = new BoxRenderable(renderer, {
    id: "rail",
    title: "projects",
    border: true,
    width: RAIL_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
  });
  const railRows: TextRenderable[] = [];
  // Selected-project header row above the config box: name left, state right.
  const paneHeaderText = new TextRenderable(renderer, { id: "pane-header-text", content: "" });
  const paneHeaderBox = new BoxRenderable(renderer, {
    id: "pane-header",
    height: PANE_HEADER_HEIGHT,
    paddingLeft: 1,
  });
  paneHeaderBox.add(paneHeaderText);
  const configText = new TextRenderable(renderer, { id: "config-text", content: "" });
  const configBox = new BoxRenderable(renderer, {
    id: "config",
    title: "config",
    border: true,
    height: CONFIG_HEIGHT,
    paddingLeft: 1,
  });
  configBox.add(configText);
  // Lines are wrapped by hand into rows, so the visible-slice math stays exact.
  const logText = new TextRenderable(renderer, { id: "log-text", content: "", wrapMode: "none" });
  const logBox = new BoxRenderable(renderer, {
    id: "log",
    title: "logs",
    border: true,
    flexGrow: 1,
    paddingLeft: 1,
  });
  logBox.add(logText);
  const rightColumn = new BoxRenderable(renderer, {
    id: "right",
    flexGrow: 1,
    flexDirection: "column",
  });
  rightColumn.add(paneHeaderBox);
  rightColumn.add(configBox);
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
    width: "100%",
    height: FOOTER_HEIGHT,
    paddingLeft: 1,
  });
  footerBox.add(footerText);
  const root = new BoxRenderable(renderer, {
    id: "tui-root",
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

  /** left-pad-right layout: `left……right` across the given content width. */
  const spread = (left: string, right: string, width: number): string => {
    const pad = Math.max(1, width - left.length - right.length);
    return `${left}${" ".repeat(pad)}${right}`;
  };

  const render = (): void => {
    // A fire-and-forget tail poll can land after quit tore the renderer down.
    if (renderer.isDestroyed) return;

    const running = views.filter((view) => view.job?.pid !== undefined).length;
    const summary = `● ${running} running`;
    const headerPad = Math.max(1, renderer.terminalWidth - 4 - "score".length - summary.length);
    headerText.content = t`score${" ".repeat(headerPad)}${fg("#3fb950")(summary)}`;
    headerText.fg = "#e6edf3";

    // Rail: a two-line card per project (name + dot, then its tick) with a
    // separator row between cards — per the wireframe.
    const CARD_ROWS = 3;
    while (railRows.length < views.length * CARD_ROWS) {
      const row = new TextRenderable(renderer, { id: `rail-row-${railRows.length}`, content: "" });
      railBox.add(row);
      railRows.push(row);
    }
    railRows.forEach((row, index) => {
      const view = views[Math.floor(index / CARD_ROWS)];
      if (view === undefined) {
        row.content = "";
        return;
      }
      const kind = index % CARD_ROWS;
      if (kind === 0) {
        const marker = view.key === selectedKey ? "▸" : " ";
        const name = `${marker}${view.key.slice(0, RAIL_INNER - 4)}`;
        // Name in the row's own color; only the dot carries the status color.
        row.content = t`${name.padEnd(RAIL_INNER - 2)}${fg(DOT_COLOR[view.dot])(DOT_CHAR[view.dot])}`;
        row.fg = view.key === selectedKey ? "#e6edf3" : "#c9d1d9";
      } else if (kind === 1) {
        const tick = view.status !== null && view.status.tick !== null ? view.status.tick : "-";
        row.content = ` tick ${tick}`;
        row.fg = "#8b949e";
      } else {
        // No separator after the last card.
        row.content =
          Math.floor(index / CARD_ROWS) === views.length - 1 ? "" : "─".repeat(RAIL_INNER);
        row.fg = "#30363d";
      }
    });

    const selected = selectedView();
    const paneWidth = renderer.terminalWidth - RAIL_WIDTH - 2;
    if (selected === undefined) {
      paneHeaderText.content = "";
      configText.content = "no projects — run: score up";
    } else {
      paneHeaderText.content = spread(
        selected.key,
        `${DOT_WORD[selected.dot]} | x to toggle`,
        paneWidth,
      );
      paneHeaderText.fg = "#e6edf3";
      const state = [
        DOT_WORD[selected.dot],
        ...(selected.job?.pid !== undefined ? [`pid ${selected.job.pid}`] : []),
        ...(selected.enabled ? [] : ["disabled"]),
      ].join(" · ");
      configText.content =
        selected.resolved === null
          ? `no resolved config — run: score up\nstate     ${state}`
          : `agent     ${selected.resolved.agent}\ntick      ${selected.resolved.tickIntervalMs} ms\nparallel  ${selected.resolved.maxParallel}\nstate     ${state}`;
    }

    // Long lines wrap (the wireframe wraps them) — rows are cut by hand so the
    // scroll window stays exact; `scroll` indexes wrapped rows, not file lines.
    const wrapWidth = Math.max(20, renderer.terminalWidth - LOG_CHROME);
    const rows = (tail?.lines ?? []).flatMap((line) => {
      const chunks: string[] = [];
      for (let at = 0; at < Math.max(1, line.length); at += wrapWidth) {
        chunks.push(line.slice(at, at + wrapWidth));
      }
      return chunks;
    });
    const visible = Math.max(
      1,
      renderer.terminalHeight -
        HEADER_HEIGHT -
        PANE_HEADER_HEIGHT -
        CONFIG_HEIGHT -
        FOOTER_HEIGHT -
        2,
    );
    const maxStart = Math.max(0, rows.length - visible);
    scroll = follow ? maxStart : Math.min(scroll, maxStart);
    logText.content = rows.slice(scroll, scroll + visible).join("\n");
    logBox.title = tail === null ? "logs" : `logs — ${tail.file}${follow ? " · follow" : ""}`;

    const error = actionError ?? pollError;
    const footer =
      error !== null
        ? `error: ${error}`
        : help
          ? "j/k select project · x stop/start via supervisor · r restart · f toggle follow · g top · G end · q quit viewer (daemons keep running)"
          : `j/k select · x ${selected?.job?.pid !== undefined ? "stop" : "start"} · r restart · f follow${follow ? " *" : ""} · g/G · ? help · q quit`;
    // Errors read left-aligned; the shortcut line sits bottom-right per the wireframe.
    footerText.content = error !== null ? footer : spread("", footer, renderer.terminalWidth - 2);
  };

  const select = (key: string | null): void => {
    if (key === selectedKey) return;
    selectedKey = key;
    follow = true;
    scroll = 0;
    tail = key === null ? null : new LogTail(logsDir(key), now);
  };

  const move = (delta: number): void => {
    if (views.length === 0) return;
    const index = views.findIndex((view) => view.key === selectedKey) + delta;
    select(views[Math.max(0, Math.min(views.length - 1, index))]?.key ?? null);
    // Fill the log pane now instead of waiting out the poll interval.
    void tail
      ?.poll()
      .catch(() => {})
      .then(render);
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
        views = await fleetSnapshot(deps.adapter, deps.config, now().getTime());
        pollError = null;
      } catch (error) {
        pollError = error instanceof Error ? error.message : String(error);
      }
      if (selectedKey === null || !views.some((view) => view.key === selectedKey)) {
        select(views[0]?.key ?? null);
      }
      await tail?.poll().catch(() => {});
      render();
    } finally {
      refreshing = false;
    }
  };

  return { refresh, handleKey, done };
}

export async function runTui(args: readonly string[]): Promise<void> {
  if (args.length > 0) throw new Error("usage: score tui");
  const config = await loadConfig();
  const adapter: SupervisorAdapter = supervisorForPlatform(new BunCommandRunner()).adapter;
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const app = buildTui(renderer, { adapter, config });
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
