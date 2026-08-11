import type {
  CreateSessionRequest,
  PromptAsyncRequest,
  SessionListResponse,
  SessionPermission,
  SessionV2Info,
} from "@score/agents/opencode-api.interface";
import type { AgentRuntime } from "@score/core/agent-runtime.interface";
import { repairSessionName } from "@score/core/dispatch/dispatch.identity";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import { parseOpencodeModel } from "@score/shared/agent-command";
import type { AgentConfig } from "@score/shared/config/config.interface";

export interface OpencodeServiceOptions {
  /** Project key namespacing every session this adapter looks up or creates. */
  readonly namespace: string;
  readonly dryRun?: boolean;
}

const ALLOW_ALL_PERMISSION: readonly SessionPermission[] = [
  { permission: "*", pattern: "*", action: "allow" },
];

/** Durable HTTP session adapter against a running `opencode serve` (locked decision 14). */
export class OpencodeService implements AgentRuntime {
  constructor(
    private readonly baseUrl: string,
    private readonly options: OpencodeServiceOptions,
  ) {}

  async sessionExists(sessionName: string): Promise<boolean> {
    return (await this.#resolveExact(sessionName)) !== undefined;
  }

  async listSessions(): Promise<readonly string[]> {
    const prefix = `score-${this.options.namespace}-`;
    const sessions = await this.#searchSessions(prefix);
    return sessions.filter((session) => session.title.startsWith(prefix)).map((s) => s.title);
  }

  async startImplementation(
    identity: WorkIdentity,
    prompt: string,
    agent: AgentConfig,
  ): Promise<void> {
    if ((await this.#resolveExact(identity.sessionName)) !== undefined) {
      throw new Error(`opencode session '${identity.sessionName}' already exists`);
    }
    const model = requireOpencodeModel(agent);
    const created = (await this.#request("POST", "/session", { directory: identity.worktreePath }, {
      title: identity.sessionName,
      permission: ALLOW_ALL_PERMISSION,
      model: { providerID: model.providerID, id: model.modelID },
    } satisfies CreateSessionRequest)) as SessionV2Info | undefined;
    if (created === undefined) return; // dry-run: create above was a no-op

    await this.#request(
      "POST",
      `/session/${created.id}/prompt_async`,
      { directory: identity.worktreePath },
      { model, parts: [{ type: "text", text: prompt }] } satisfies PromptAsyncRequest,
    );
  }

  async ping(sessionName: string, message: string): Promise<void> {
    const resolved = await this.#resolveExact(sessionName);
    if (resolved === undefined) throw new Error(`no opencode session titled '${sessionName}'`);

    const session = (await this.#request("GET", `/session/${resolved.id}`, {
      directory: resolved.directory,
    })) as SessionV2Info;
    const pin = session.model;

    await this.#request(
      "POST",
      `/session/${resolved.id}/prompt_async`,
      { directory: resolved.directory },
      {
        ...(pin !== undefined && { model: { providerID: pin.providerID, modelID: pin.id } }),
        parts: [{ type: "text", text: message }],
      } satisfies PromptAsyncRequest,
    );
  }

  async startRepair(
    pullRequestNumber: number,
    worktreePath: string,
    message: string,
    agent: AgentConfig,
  ): Promise<void> {
    const title = repairSessionName(this.options.namespace, pullRequestNumber);
    const existing = await this.#resolveExact(title);
    if (existing !== undefined) {
      await this.#request("POST", `/session/${existing.id}/abort`, {
        directory: existing.directory,
      });
      await this.#request("DELETE", `/session/${existing.id}`, { directory: existing.directory });
    }

    const model = requireOpencodeModel(agent);
    const created = (await this.#request("POST", "/session", { directory: worktreePath }, {
      title,
      permission: ALLOW_ALL_PERMISSION,
      model: { providerID: model.providerID, id: model.modelID },
    } satisfies CreateSessionRequest)) as SessionV2Info | undefined;
    if (created === undefined) return; // dry-run: create above was a no-op

    await this.#request(
      "POST",
      `/session/${created.id}/prompt_async`,
      { directory: worktreePath },
      { model, parts: [{ type: "text", text: message }] } satisfies PromptAsyncRequest,
    );
  }

  async stop(sessionName: string): Promise<void> {
    const resolved = await this.#resolveExact(sessionName);
    if (resolved === undefined) return;
    await this.#request("POST", `/session/${resolved.id}/abort`, { directory: resolved.directory });
    await this.#request("DELETE", `/session/${resolved.id}`, { directory: resolved.directory });
  }

  /** Global, exact-title identity (locked decision 7); the ID alone is never sufficient (decision 8). */
  async #resolveExact(title: string): Promise<{ id: string; directory: string } | undefined> {
    const matches = (await this.#searchSessions(title)).filter(
      (session) => session.title === title,
    );
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new Error(
        `opencode: ${matches.length} sessions titled '${title}', expected at most one`,
      );
    }
    const [session] = matches as [SessionV2Info];
    const directory = session.location.directory;
    if (!directory) {
      throw new Error(`opencode: session '${title}' (${session.id}) has no location.directory`);
    }
    return { id: session.id, directory };
  }

  /** GET /api/session, walked to exhaustion — the directory-scoped GET /session is never used for lookup. */
  async #searchSessions(search: string): Promise<SessionV2Info[]> {
    const sessions: SessionV2Info[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = (await this.#request("GET", "/api/session", {
        search,
        cursor,
      })) as SessionListResponse;
      sessions.push(...page.data);
      if (page.cursor.next === undefined) return sessions;
      cursor = page.cursor.next;
    }
  }

  /** GET always executes; POST/DELETE no-op under dry-run (locked decision 12). */
  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Record<string, string | undefined> = {},
    body?: unknown,
  ): Promise<unknown> {
    if (method !== "GET" && this.options.dryRun) return undefined;

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    if (!response.ok) {
      throw new Error(`opencode ${method} ${url.pathname}${url.search} -> ${response.status}`);
    }
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
  }
}

/** Managed config guarantees a model; reaching a create path without one is a programming error. */
function requireOpencodeModel(agent: AgentConfig): { providerID: string; modelID: string } {
  if (agent.model === undefined) {
    throw new Error("opencode agent config is missing a model (harness 'opencode' has no default)");
  }
  return parseOpencodeModel(agent.model, "agent.model");
}
