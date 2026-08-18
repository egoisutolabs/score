import type { SupervisorAdapter } from "@score/core/supervisor/supervisor-adapter.interface";
import { restartProject, startProject, stopProject } from "./actions";
import type { GitHubMerge, HistoryEvent } from "./history";
import type { ProjectView, TuiDataSource } from "./server-client.interface";

export interface TuiDeps {
  readonly adapter: SupervisorAdapter;
  readonly data: TuiDataSource;
}

export interface TuiKey {
  readonly name: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
}

export interface TuiSnapshot {
  readonly views: readonly ProjectView[];
  readonly selectedKey: string | null;
  readonly logs: ReadonlyMap<string, readonly string[]>;
  readonly logFile: string;
  readonly history: readonly HistoryEvent[];
  readonly githubMerges: readonly GitHubMerge[];
  readonly historyDays: 7 | 30;
  readonly view: "overview" | "history";
  readonly follow: boolean;
  readonly logStart: number;
  readonly copyMode: boolean;
  readonly help: boolean;
  readonly actionError: string | null;
  readonly pollError: string | null;
}

const EMPTY_SNAPSHOT: TuiSnapshot = {
  views: [],
  selectedKey: null,
  logs: new Map(),
  logFile: "",
  history: [],
  githubMerges: [],
  historyDays: 30,
  view: "overview",
  follow: true,
  logStart: 0,
  copyMode: false,
  help: false,
  actionError: null,
  pollError: null,
};

/** Owns TUI interaction state; rendering and terminal lifecycle stay in app.tsx. */
export class TuiService {
  #snapshot: TuiSnapshot = EMPTY_SNAPSHOT;
  #refreshing = false;
  #actionInFlight = false;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly deps: TuiDeps) {}

  get snapshot(): TuiSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      try {
        const state = await this.deps.data.poll();
        const views = [...state.projects];
        const selectedKey =
          this.#snapshot.selectedKey !== null &&
          views.some((view) => view.key === this.#snapshot.selectedKey)
            ? this.#snapshot.selectedKey
            : (views[0]?.key ?? null);
        this.#replace({
          ...this.#snapshot,
          views,
          selectedKey,
          logs: state.logs,
          logFile: state.logFile,
          history: state.history,
          githubMerges: state.githubMerges,
          pollError: state.warnings.length === 0 ? null : state.warnings.join(", "),
        });
      } catch (error) {
        this.#replace({
          ...this.#snapshot,
          pollError: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.#refreshing = false;
    }
  }

  /** Returns true when the terminal viewer should exit. */
  handleKey(key: TuiKey): boolean {
    if (key.name === "q" || (key.ctrl === true && key.name === "c")) return true;
    if (key.name === "escape" && this.#snapshot.copyMode) this.#patch({ copyMode: false });
    else if (key.name === "1") this.#patch({ view: "overview", copyMode: false });
    else if (key.name === "2") this.#patch({ view: "history", copyMode: false });
    else if (key.name === "7" && this.#snapshot.view === "history") {
      this.#patch({ historyDays: 7 });
    } else if (key.name === "3" && this.#snapshot.view === "history") {
      this.#patch({ historyDays: 30 });
    } else if (key.name === "tab") {
      this.#patch({
        view: this.#snapshot.view === "overview" ? "history" : "overview",
        copyMode: false,
      });
    } else if (key.name === "j" || key.name === "down") this.#move(1);
    else if (key.name === "k" || key.name === "up") this.#move(-1);
    else if (key.name === "u" || key.name === "pageup") this.#scrollLogs(-8);
    else if (key.name === "d" || key.name === "pagedown") this.#scrollLogs(8);
    else if (key.name === "g" && key.shift === true) this.#patch({ follow: true, logStart: 0 });
    else if (key.name === "g") this.#patch({ follow: false, logStart: 0 });
    else if (key.name === "f") this.#toggleFollow();
    else if (key.name === "c" && this.#snapshot.view === "overview") {
      this.#patch({ copyMode: !this.#snapshot.copyMode });
    } else if (key.name === "?") this.#patch({ help: !this.#snapshot.help });
    else if (key.name === "x") this.#toggleSelected();
    else if (key.name === "r") this.#restartSelected();
    return false;
  }

  #move(delta: number): void {
    if (this.#snapshot.views.length === 0) return;
    const current = this.#snapshot.views.findIndex(
      (view) => view.key === this.#snapshot.selectedKey,
    );
    const index = Math.max(0, Math.min(this.#snapshot.views.length - 1, current + delta));
    this.#patch({
      selectedKey: this.#snapshot.views[index]?.key ?? null,
      follow: true,
      logStart: 0,
    });
  }

  #toggleFollow(): void {
    if (!this.#snapshot.follow) {
      this.#patch({ follow: true, logStart: 0 });
      return;
    }
    this.#patch({ follow: false, logStart: Math.max(0, this.#selectedLogCount() - 8) });
  }

  #scrollLogs(delta: number): void {
    const count = this.#selectedLogCount();
    const bottom = Math.max(0, count - 8);
    const current = this.#snapshot.follow ? bottom : this.#snapshot.logStart;
    const next = this.#snapshot.follow && delta > 0 ? bottom : current + delta;
    this.#patch({
      follow: false,
      logStart: Math.max(0, Math.min(Math.max(0, count - 1), next)),
    });
  }

  #selectedLogCount(): number {
    if (this.#snapshot.selectedKey === null) return 0;
    return this.#snapshot.logs.get(this.#snapshot.selectedKey)?.length ?? 0;
  }

  #toggleSelected(): void {
    const view = this.#selectedView();
    if (view?.job?.pid !== undefined) {
      this.#runAction(stopProject);
      return;
    }
    if (view !== undefined && !view.enabled) {
      this.#patch({ actionError: `'${view.key}' is disabled in config — not starting` });
      return;
    }
    // A crashed job is registered; a booted-out job needs install before start.
    const registered = view?.job?.loaded === true;
    this.#runAction((adapter, key) => startProject(adapter, key, registered));
  }

  #restartSelected(): void {
    const view = this.#selectedView();
    if (view !== undefined && !view.enabled) {
      this.#patch({ actionError: `'${view.key}' is disabled in config — not starting` });
      return;
    }
    this.#runAction(restartProject);
  }

  #runAction(action: (adapter: SupervisorAdapter, key: string) => Promise<void>): void {
    const view = this.#selectedView();
    // Serial actions prevent a failing supervisor from becoming a retry storm.
    if (view === undefined || this.#actionInFlight) return;
    this.#actionInFlight = true;
    this.#patch({ actionError: null });
    action(this.deps.adapter, view.key)
      .catch((error: unknown) => {
        this.#patch({ actionError: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.#actionInFlight = false;
        this.#emit();
      });
  }

  #selectedView(): ProjectView | undefined {
    return this.#snapshot.views.find((view) => view.key === this.#snapshot.selectedKey);
  }

  #patch(patch: Partial<TuiSnapshot>): void {
    this.#replace({ ...this.#snapshot, ...patch });
  }

  #replace(snapshot: TuiSnapshot): void {
    this.#snapshot = snapshot;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
