import type { HealthState } from "@score/core/observation/health.policy";
import { dotForHealth } from "./dots";
import type { ProjectView, TuiDataSource, TuiPoll } from "./server-client.interface";

const INITIAL_LINES = 200;
const MAX_LINES = 2000;
const DEFAULT_SERVER_URL = "http://127.0.0.1:3000";

const FLEET_SNAPSHOT_EVENT = "score.snapshot.fleet";
const PROJECT_SNAPSHOT_EVENT = "score.snapshot.project";
const LOG_RECORD_EVENT = "score.log.record";
const CAUGHT_UP_EVENT = "score.stream.caught_up";
const WARNING_EVENT = "score.stream.warning";

interface WireWarning {
  readonly reason: string;
}

interface WireEnvelope {
  readonly cursor: string;
  readonly data: unknown;
  readonly warnings?: readonly WireWarning[];
}

interface SseMessage {
  readonly event: string;
  readonly id: string;
  readonly envelope: WireEnvelope;
}

interface RequestFailure {
  readonly status: number;
  readonly reason: string;
}

/**
 * Cursor-backed finite subscriptions for the TUI. Each poll gets fresh owner
 * snapshots and only log records after the prior caught-up boundary; the TUI
 * never reads Score's state files or dated logs itself.
 */
export class TuiServerClient implements TuiDataSource {
  #cursor = "";
  #stamp = "";
  readonly #logs = new Map<string, string[]>();
  readonly #baseUrl: URL;

  constructor(
    baseUrl: string | undefined = DEFAULT_SERVER_URL,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#baseUrl = new URL(baseUrl ?? DEFAULT_SERVER_URL);
  }

  async poll(): Promise<TuiPoll> {
    try {
      return await this.#poll();
    } catch (error) {
      const failure = error as Partial<RequestFailure>;
      if (failure.status !== 410 || failure.reason !== "CURSOR_EXPIRED" || this.#cursor === "") {
        throw error;
      }
      // Retention invalidated the saved position. A fresh bounded-to-today
      // replay is the only safe recovery; the server remains cursor authority.
      this.#cursor = "";
      this.#logs.clear();
      return await this.#poll();
    }
  }

  async #poll(): Promise<TuiPoll> {
    const stamp = this.now().toISOString().slice(0, 10);
    const freshBuffer = this.#cursor === "" || stamp !== this.#stamp;
    if (stamp !== this.#stamp) {
      this.#stamp = stamp;
      this.#logs.clear();
    }

    const url = new URL("/api/v1/stream", this.#baseUrl);
    url.searchParams.set("signals", "snapshot,log");
    url.searchParams.set("since", `${stamp}T00:00:00.000Z`);
    url.searchParams.set("follow", "false");
    const headers = new Headers();
    if (this.#cursor !== "") headers.set("Last-Event-ID", this.#cursor);

    const response = await this.request(url, { headers });
    const text = await response.text();
    if (!response.ok) throw requestFailure(response.status, text);

    const projects: ProjectView[] = [];
    const pendingLogs = new Map<string, string[]>();
    const warnings = new Set<string>();
    let caughtUp = false;
    let nextCursor = this.#cursor;
    for (const message of parseSse(text)) {
      for (const warning of message.envelope.warnings ?? []) warnings.add(warning.reason);
      if (message.event === FLEET_SNAPSHOT_EVENT) continue;
      if (message.event === PROJECT_SNAPSHOT_EVENT) {
        projects.push(projectView(message.envelope.data));
      } else if (message.event === LOG_RECORD_EVENT) {
        const record = logRecord(message.envelope.data);
        const lines = pendingLogs.get(record.project) ?? [];
        lines.push(`[${record.ts}] [${record.level}] ${record.body}`);
        pendingLogs.set(record.project, lines);
      } else if (message.event === WARNING_EVENT) {
        for (const warning of message.envelope.warnings ?? []) warnings.add(warning.reason);
      } else if (message.event === CAUGHT_UP_EVENT) {
        caughtUp = true;
      }
      if (message.envelope.cursor !== "") nextCursor = message.envelope.cursor;
      else if (message.id !== "") nextCursor = message.id;
    }
    if (!caughtUp) throw new Error("server stream ended before score.stream.caught_up");

    this.#cursor = nextCursor;
    for (const [project, additions] of pendingLogs) {
      const lines = this.#logs.get(project) ?? [];
      lines.push(...additions);
      this.#logs.set(project, lines);
    }
    const cap = freshBuffer ? INITIAL_LINES : MAX_LINES;
    for (const lines of this.#logs.values()) {
      if (lines.length > cap) lines.splice(0, lines.length - cap);
    }
    return {
      projects,
      logs: this.#logs,
      logFile: `${stamp}.log`,
      warnings: [...warnings],
    };
  }
}

function parseSse(text: string): readonly SseMessage[] {
  const messages: SseMessage[] = [];
  for (const block of text.split("\n\n")) {
    if (block === "" || block.startsWith(":")) continue;
    let event = "";
    let id = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (event === "" || data.length === 0) continue;
    const parsed: unknown = JSON.parse(data.join("\n"));
    messages.push({ event, id, envelope: envelope(parsed) });
  }
  return messages;
}

function envelope(value: unknown): WireEnvelope {
  const raw = object(value, "stream envelope");
  if (typeof raw.cursor !== "string") throw new Error("server returned an invalid stream envelope");
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.map((entry) => {
        const warning = object(entry, "stream warning");
        if (typeof warning.reason !== "string")
          throw new Error("server returned an invalid warning");
        return { reason: warning.reason };
      })
    : undefined;
  return { cursor: raw.cursor, data: raw.data, ...(warnings && { warnings }) };
}

function projectView(value: unknown): ProjectView {
  const raw = object(value, "project snapshot");
  const health = object(raw.health, "project health");
  if (
    typeof raw.project !== "string" ||
    !["healthy", "stale", "crashed", "stopped"].includes(String(health.state))
  ) {
    throw new Error("server returned an invalid project snapshot");
  }

  const supervisor = raw.supervisor === null ? null : object(raw.supervisor, "supervisor snapshot");
  const status = raw.status === null ? null : object(raw.status, "status snapshot");
  const config = raw.config === null ? null : object(raw.config, "config snapshot");
  const harness = config === null || typeof config.harness !== "string" ? "?" : config.harness;
  const model = config !== null && typeof config.model === "string" ? ` · ${config.model}` : "";
  return {
    key: raw.project,
    enabled: raw.enabled === true,
    job:
      supervisor === null || typeof supervisor.loaded !== "boolean"
        ? undefined
        : {
            key: raw.project,
            loaded: supervisor.loaded,
            ...(typeof supervisor.pid === "number" && { pid: supervisor.pid }),
          },
    status: status === null ? null : { tick: typeof status.tick === "number" ? status.tick : null },
    resolved:
      config === null
        ? null
        : {
            agent: `${harness}${model}`,
            tickIntervalMs:
              typeof config.tick_interval_ms === "number" ? config.tick_interval_ms : 60_000,
            maxParallel: typeof config.max_parallel === "number" ? config.max_parallel : 1,
          },
    dot: dotForHealth(health.state as HealthState),
  };
}

function logRecord(value: unknown): {
  readonly project: string;
  readonly ts: string;
  readonly level: string;
  readonly body: string;
} {
  const raw = object(value, "log record");
  if (
    typeof raw.project !== "string" ||
    typeof raw.ts !== "string" ||
    typeof raw.level !== "string" ||
    typeof raw.body !== "string"
  ) {
    throw new Error("server returned an invalid log record");
  }
  return { project: raw.project, ts: raw.ts, level: raw.level, body: raw.body };
}

function requestFailure(status: number, text: string): Error & RequestFailure {
  let reason = `HTTP_${status}`;
  try {
    const raw = object(JSON.parse(text), "error envelope");
    const warning = Array.isArray(raw.warnings) ? object(raw.warnings[0], "error warning") : null;
    if (warning !== null && typeof warning.reason === "string") reason = warning.reason;
  } catch {
    // A non-envelope response still reports its status without exposing body text.
  }
  return Object.assign(new Error(`server request failed: ${reason}`), { status, reason });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`server returned an invalid ${name}`);
  }
  return value as Record<string, unknown>;
}
