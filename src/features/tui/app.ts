import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  TextRenderable,
} from "@opentui/core";
import { BunCommandRunner } from "@/adapters/command-runner";
import { logsDir } from "@/features/config/layout";
import { loadConfig } from "@/features/config/load";
import type { ScoreConfig } from "@/features/config/model";
import type { SupervisorAdapter } from "@/features/supervisor/adapter";
import { LaunchdSupervisor } from "@/features/supervisor/launchd";
import { restartProject, startProject, stopProject } from "@/features/tui/actions";
import type { Dot } from "@/features/tui/dots";
import { fleetSnapshot, type ProjectView } from "@/features/tui/snapshot";
import { LogTail } from "@/features/tui/tail";

const RAIL_WIDTH = 26;
const CONFIG_HEIGHT = 6;
const FOOTER_HEIGHT = 1;
const POLL_MS = 1000;

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

  const railBox = new BoxRenderable(renderer, {
    id: "rail",
    title: "projects",
    border: true,
    width: RAIL_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
  });
  const railRows: TextRenderable[] = [];
  const configText = new TextRenderable(renderer, { id: "config-text", content: "" });
  const configBox = new BoxRenderable(renderer, {
    id: "config",
    title: "config",
    border: true,
    height: CONFIG_HEIGHT,
    paddingLeft: 1,
  });
  configBox.add(configText);
  // wrapMode none keeps one log line per row, so the visible-slice math holds.
  const logText = new TextRenderable(renderer, { id: "log-text", content: "", wrapMode: "none" });
  const logBox = new BoxRenderable(renderer, {
    id: "log",
    title: "log",
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
  root.add(mainRow);
  root.add(footerBox);
  renderer.root.add(root);

  const selectedView = (): ProjectView | undefined =>
    views.find((view) => view.key === selectedKey);

  const render = (): void => {
    // A fire-and-forget tail poll can land after quit tore the renderer down.
    if (renderer.isDestroyed) return;
    while (railRows.length < views.length) {
      const row = new TextRenderable(renderer, { id: `rail-row-${railRows.length}`, content: "" });
      railBox.add(row);
      railRows.push(row);
    }
    railRows.forEach((row, index) => {
      const view = views[index];
      if (view === undefined) {
        row.content = "";
        return;
      }
      const tick = view.status !== null && view.status.tick !== null ? `#${view.status.tick}` : "-";
      row.content = `${view.key === selectedKey ? "▸" : " "}${DOT_CHAR[view.dot]} ${view.key
        .slice(0, RAIL_WIDTH - 9)
        .padEnd(RAIL_WIDTH - 9)} ${tick}`;
      row.fg = DOT_COLOR[view.dot];
    });

    const selected = selectedView();
    configBox.title = selected === undefined ? "config" : selected.key;
    if (selected === undefined) {
      configText.content = "no projects — run: score up";
    } else {
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

    const lines = tail?.lines ?? [];
    const visible = Math.max(1, renderer.terminalHeight - CONFIG_HEIGHT - FOOTER_HEIGHT - 2);
    const maxStart = Math.max(0, lines.length - visible);
    scroll = follow ? maxStart : Math.min(scroll, maxStart);
    logText.content = lines.slice(scroll, scroll + visible).join("\n");
    logBox.title = tail === null ? "log" : `log — ${tail.file}${follow ? " · follow" : ""}`;

    const error = actionError ?? pollError;
    footerText.content =
      error !== null
        ? `error: ${error}`
        : help
          ? "j/k select project · x stop/start via supervisor · r restart · f toggle follow · g top · G end · q quit viewer (daemons keep running)"
          : `j/k select · x ${selected?.job?.pid !== undefined ? "stop" : "start"} · r restart · f follow${follow ? " *" : ""} · g/G · ? help · q quit`;
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
      runAction(selectedView()?.job?.pid !== undefined ? stopProject : startProject);
    } else if (key.name === "r") runAction(restartProject);
    else return;
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
  const adapter: SupervisorAdapter = new LaunchdSupervisor(new BunCommandRunner());
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
