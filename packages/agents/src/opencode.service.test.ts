import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpencodeService } from "@score/agents/opencode.service";
import type {
  CreateSessionRequest,
  SessionListResponse,
  SessionV2Info,
} from "@score/agents/opencode-api.interface";
import { RepairLedger } from "@score/core/daemon/repair-ledger.service";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import type { AgentConfig } from "@score/shared/config/config.interface";
import { afterEach, beforeEach, expect, test } from "vitest";

/**
 * A real HTTP server, not Bun.serve: this repo's `bun run test` runs vitest
 * under the system's node (the `vitest` binary's own `#!/usr/bin/env node`
 * shebang wins over the invoking `bun run`), so `Bun.serve`/`Bun.sleep` are
 * unavailable inside test files here. node:http gives an identical fake —
 * a real listening server recording every request — without a new dependency.
 */

const PAGE_SIZE = 2;

interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

interface FakeOpencode {
  readonly url: string;
  readonly requests: FakeRequest[];
  readonly sessions: SessionV2Info[];
  failNext(status: number): void;
  close(): Promise<void>;
}

function session(id: string, title: string, directory: string): SessionV2Info {
  return {
    id,
    projectID: "proj_test",
    cost: 0,
    tokens: {},
    time: {},
    title,
    location: { directory },
  };
}

function sendJson(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function startFakeOpencode(): Promise<FakeOpencode> {
  const requests: FakeRequest[] = [];
  const sessions: SessionV2Info[] = [];
  let idCounter = 0;
  let nextStatus: number | undefined;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: unknown = raw.length > 0 ? JSON.parse(raw) : undefined;
    const query = Object.fromEntries(url.searchParams.entries());
    requests.push({ method, path: url.pathname, query, body });

    if (nextStatus !== undefined) {
      const status = nextStatus;
      nextStatus = undefined;
      sendJson(res, status, { error: "forced failure" });
      return;
    }

    if (method === "GET" && url.pathname === "/session") {
      // The trap route (directory-scoped): must never be requested for lookup.
      sendJson(res, 500, { error: "GET /session must never be used for lookup" });
      return;
    }

    if (method === "GET" && url.pathname === "/api/session") {
      const search = query.search ?? "";
      const matches = sessions.filter((candidate) => candidate.title.includes(search));
      const cursor = query.cursor ? Number(query.cursor) : 0;
      const page = matches.slice(cursor, cursor + PAGE_SIZE);
      const next = cursor + PAGE_SIZE < matches.length ? String(cursor + PAGE_SIZE) : undefined;
      sendJson(res, 200, { data: page, cursor: { next } } satisfies SessionListResponse);
      return;
    }

    if (method === "POST" && url.pathname === "/session") {
      const create = body as CreateSessionRequest;
      const created: SessionV2Info = {
        id: `ses_${++idCounter}`,
        projectID: "proj_test",
        cost: 0,
        tokens: {},
        time: {},
        title: create.title,
        location: { directory: query.directory ?? "" },
        ...(create.model !== undefined && {
          model: { id: create.model.id, providerID: create.model.providerID },
        }),
      };
      sessions.push(created);
      sendJson(res, 200, created);
      return;
    }

    const scoped = /^\/session\/([^/]+)(?:\/(prompt_async|abort))?$/.exec(url.pathname);
    if (scoped) {
      const id = scoped[1] as string;
      const action = scoped[2];
      if (method === "GET" && action === undefined) {
        const found = sessions.find((candidate) => candidate.id === id);
        if (!found) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, found);
        return;
      }
      if (method === "POST" && action === "prompt_async") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && action === "abort") {
        sendJson(res, 200, true);
        return;
      }
      if (method === "DELETE" && action === undefined) {
        const index = sessions.findIndex((candidate) => candidate.id === id);
        if (index >= 0) sessions.splice(index, 1);
        sendJson(res, 200, true);
        return;
      }
    }

    sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    sessions,
    failNext(status: number) {
      nextStatus = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function workIdentity(overrides: Partial<WorkIdentity> = {}): WorkIdentity {
  return {
    issueNumber: 7,
    branch: "issue-7-demo",
    worktreePath: "/work/issue-7-demo",
    sessionName: "score-ns-issue-7",
    ...overrides,
  };
}

const AGENT: AgentConfig = { harness: "opencode", model: "openai/o4" };

let fake: FakeOpencode;
let service: OpencodeService;

beforeEach(async () => {
  fake = await startFakeOpencode();
  service = new OpencodeService(fake.url, { namespace: "ns" });
});

afterEach(async () => {
  await fake.close();
});

test("resolveExact finds sessions across two different directories, never using bare GET /session", async () => {
  fake.sessions.push(
    session("ses_a", "score-ns-issue-1", "/work/a"),
    session("ses_b", "score-ns-issue-2", "/work/b"),
  );

  await expect(service.sessionExists("score-ns-issue-1")).resolves.toBe(true);
  await expect(service.sessionExists("score-ns-issue-2")).resolves.toBe(true);
  expect(fake.requests.some((r) => r.method === "GET" && r.path === "/session")).toBe(false);
});

test("an exact match on page 2 is found; earlier substring-only matches don't satisfy the exact filter", async () => {
  fake.sessions.push(
    session("ses_10", "score-ns-issue-10", "/work/10"),
    session("ses_11", "score-ns-issue-11", "/work/11"),
    session("ses_1", "score-ns-issue-1", "/work/1"),
  );

  await expect(service.sessionExists("score-ns-issue-1")).resolves.toBe(true);
  const searches = fake.requests.filter((r) => r.path === "/api/session");
  expect(searches.length).toBeGreaterThan(1);
});

test("listSessions aggregates titles across pages, filtered to the exact score-<namespace>- prefix", async () => {
  fake.sessions.push(
    session("ses_1", "score-ns-issue-1", "/work/1"),
    session("ses_2", "score-ns-issue-2", "/work/2"),
    session("ses_3", "score-ns-issue-3", "/work/3"),
    session("ses_decoy", "xscore-ns-issue-9", "/work/decoy"), // substring match, not a prefix match
  );

  const listed = await service.listSessions();
  expect([...listed].sort()).toEqual(["score-ns-issue-1", "score-ns-issue-2", "score-ns-issue-3"]);
  const searches = fake.requests.filter((r) => r.path === "/api/session");
  expect(searches.length).toBeGreaterThan(1); // 4 substring matches, PAGE_SIZE 2 forces a second page
});

test("duplicate exact titles make sessionExists, ping, stop, and startImplementation all throw", async () => {
  fake.sessions.push(
    session("ses_a", "dup-session", "/work/a"),
    session("ses_b", "dup-session", "/work/b"),
  );

  await expect(service.sessionExists("dup-session")).rejects.toThrow(/duplicate|2 sessions/i);
  await expect(service.ping("dup-session", "hi")).rejects.toThrow();
  await expect(service.stop("dup-session")).rejects.toThrow();
  await expect(
    service.startImplementation(workIdentity({ sessionName: "dup-session" }), "prompt", AGENT),
  ).rejects.toThrow();
});

test("startImplementation refuses an existing title before issuing any create or prompt request", async () => {
  fake.sessions.push(session("ses_1", "score-ns-issue-7", "/work/7"));

  await expect(
    service.startImplementation(workIdentity({ sessionName: "score-ns-issue-7" }), "prompt", AGENT),
  ).rejects.toThrow("already exists");
  expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
});

test("startImplementation throws when the opencode agent config has no model", async () => {
  await expect(
    service.startImplementation(workIdentity({ sessionName: "score-ns-issue-8" }), "prompt", {
      harness: "opencode",
    }),
  ).rejects.toThrow(/model/);
  expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
});

test("startImplementation creates the session in the given directory and prompts with the translated model", async () => {
  const identity = workIdentity({ sessionName: "score-ns-issue-55", worktreePath: "/work/55" });

  await service.startImplementation(identity, "read TASK.md", AGENT);

  const create = fake.requests.find((r) => r.method === "POST" && r.path === "/session");
  expect(create?.query.directory).toBe("/work/55");
  expect(create?.body).toEqual({
    title: "score-ns-issue-55",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
    model: { providerID: "openai", id: "o4" },
  });

  const createdId = fake.sessions.find((s) => s.title === "score-ns-issue-55")?.id;
  const prompt = fake.requests.find(
    (r) => r.method === "POST" && r.path === `/session/${createdId}/prompt_async`,
  );
  expect(prompt?.query.directory).toBe("/work/55");
  expect(prompt?.body).toEqual({
    model: { providerID: "openai", modelID: "o4" },
    parts: [{ type: "text", text: "read TASK.md" }],
  });
});

test("ping sends the model recovered from GET /session/{id}, or omits it when unpinned", async () => {
  fake.sessions.push(
    {
      ...session("ses_pinned", "pinned-session", "/work/pinned"),
      model: { id: "o4", providerID: "openai" },
    },
    session("ses_bare", "bare-session", "/work/bare"),
  );

  await service.ping("pinned-session", "hello");
  const pinnedPrompt = fake.requests.find((r) => r.path === "/session/ses_pinned/prompt_async");
  expect(pinnedPrompt?.body).toEqual({
    model: { providerID: "openai", modelID: "o4" },
    parts: [{ type: "text", text: "hello" }],
  });

  await service.ping("bare-session", "hi");
  const barePrompt = fake.requests.find((r) => r.path === "/session/ses_bare/prompt_async");
  expect(barePrompt?.body).toEqual({ parts: [{ type: "text", text: "hi" }] });
});

test("ping throws when no session has that title", async () => {
  await expect(service.ping("missing-session", "hi")).rejects.toThrow("no opencode session");
});

test("stop issues abort strictly before delete; a missing session issues neither", async () => {
  fake.sessions.push(session("ses_1", "score-ns-issue-9", "/work/9"));

  await service.stop("score-ns-issue-9");
  const abortIndex = fake.requests.findIndex(
    (r) => r.method === "POST" && r.path === "/session/ses_1/abort",
  );
  const deleteIndex = fake.requests.findIndex(
    (r) => r.method === "DELETE" && r.path === "/session/ses_1",
  );
  expect(abortIndex).toBeGreaterThanOrEqual(0);
  expect(deleteIndex).toBeGreaterThan(abortIndex);

  const before = fake.requests.length;
  await service.stop("never-existed");
  const after = fake.requests.slice(before);
  expect(after.some((r) => r.method === "POST" || r.method === "DELETE")).toBe(false);
});

test("startRepair aborts and deletes an existing exact-title session before creating a fresh one", async () => {
  fake.sessions.push(session("ses_old", "score-ns-shepherd-pr-12", "/work/old"));

  await service.startRepair(12, "/work/new-12", "fix it", AGENT);

  const abortIndex = fake.requests.findIndex(
    (r) => r.method === "POST" && r.path === "/session/ses_old/abort",
  );
  const deleteIndex = fake.requests.findIndex(
    (r) => r.method === "DELETE" && r.path === "/session/ses_old",
  );
  const createIndex = fake.requests.findIndex((r) => r.method === "POST" && r.path === "/session");
  expect(abortIndex).toBeGreaterThanOrEqual(0);
  expect(deleteIndex).toBeGreaterThan(abortIndex);
  expect(createIndex).toBeGreaterThan(deleteIndex);

  const created = fake.sessions.find((s) => s.title === "score-ns-shepherd-pr-12");
  expect(created?.location.directory).toBe("/work/new-12");
});

test("dry-run issues zero POST/DELETE requests across a full sequence while GETs still occur", async () => {
  fake.sessions.push(session("ses_ping", "ping-target", "/work/ping"));
  const dryService = new OpencodeService(fake.url, { namespace: "ns", dryRun: true });

  await dryService.startImplementation(
    workIdentity({ sessionName: "score-ns-issue-99" }),
    "prompt",
    AGENT,
  );
  await dryService.ping("ping-target", "hello");
  await dryService.startRepair(42, "/work/pr-42", "fix it", AGENT);
  await dryService.stop("ping-target");

  expect(fake.requests.some((r) => r.method === "POST" || r.method === "DELETE")).toBe(false);
  expect(fake.requests.some((r) => r.method === "GET")).toBe(true);
});

test("a non-2xx response throws with method, path, and status", async () => {
  fake.sessions.push(session("ses_1", "score-ns-issue-5", "/work/5"));
  fake.failNext(500);

  await expect(service.sessionExists("score-ns-issue-5")).rejects.toThrow(/GET .*500/);
});

test("a session without location.directory throws — the ID alone is not sufficient", async () => {
  fake.sessions.push({
    id: "ses_bad",
    projectID: "p",
    cost: 0,
    tokens: {},
    time: {},
    title: "broken-session",
    location: {},
  } as unknown as SessionV2Info);

  await expect(service.sessionExists("broken-session")).rejects.toThrow(/location\.directory/);
});

test("every session-scoped request carries the directory query parameter matching location.directory", async () => {
  fake.sessions.push(session("ses_1", "score-ns-issue-3", "/work/3"));

  await service.ping("score-ns-issue-3", "hi");
  await service.stop("score-ns-issue-3");

  const scoped = fake.requests.filter((r) => r.path.startsWith("/session/"));
  expect(scoped.length).toBeGreaterThan(0);
  for (const request of scoped) {
    expect(request.query.directory).toBe("/work/3");
  }
  const searches = fake.requests.filter((r) => r.path === "/api/session");
  expect(searches.every((r) => r.query.directory === undefined)).toBe(true);
});

test("listSessions output feeds RepairLedger.startPass — an idle session counts as existing", async () => {
  fake.sessions.push(session("ses_1", "score-ns-shepherd-pr-7", "/work/7"));
  const ledger = new RepairLedger(3);
  const defects = { conflicting: false, unresolvedThreads: 0, failingChecks: 0 };

  ledger.startPass(1, new Set(await service.listSessions()));
  expect(ledger.shouldAct(7, defects)).toBe(true);
  ledger.finishPass([
    { pullRequestNumber: 7, action: "PINGED", dryRun: false, target: "score-ns-shepherd-pr-7" },
  ]);

  // The fake session is still idle (no activity field) — existence alone keeps the ledger quiet.
  ledger.startPass(2, new Set(await service.listSessions()));
  expect(ledger.shouldAct(7, defects)).toBe(false);
});

test("a wedged server fails the request within requestTimeoutMs instead of hanging forever", async () => {
  // Accepts the connection but never responds — simulates opencode serve
  // going unresponsive without exiting, so unexpectedExit never fires either.
  const hung = createServer(() => {});
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const { port } = hung.address() as AddressInfo;
  const wedged = new OpencodeService(`http://127.0.0.1:${port}`, {
    namespace: "ns",
    requestTimeoutMs: 200,
  });

  const startedAt = Date.now();
  await expect(wedged.listSessions()).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(2_000);

  await new Promise<void>((resolve, reject) =>
    hung.close((error) => (error ? reject(error) : resolve())),
  );
});
