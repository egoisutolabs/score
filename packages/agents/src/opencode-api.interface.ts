/**
 * Hand-written mirror of the OpenCode HTTP API surface Score touches (locked
 * decision 15 — no SDK). Re-probed 2026-08-11 against OpenCode 1.17.15.
 */

export interface SessionLocation {
  readonly directory: string;
  readonly workspaceID?: string;
}

/** The durable model pin a session was created or last prompted with. */
export interface SessionModelPin {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

export interface SessionV2Info {
  readonly id: string;
  readonly projectID: string;
  readonly cost: unknown;
  readonly tokens: unknown;
  readonly time: unknown;
  readonly title: string;
  readonly location: SessionLocation;
  readonly model?: SessionModelPin;
}

/** GET /api/session — data and cursor are both always present. */
export interface SessionListResponse {
  readonly data: readonly SessionV2Info[];
  /** 1.18.15 sends explicit nulls at exhaustion: {"previous":null,"next":null}. */
  readonly cursor: {
    readonly previous?: string | null;
    readonly next?: string | null;
  };
}

export interface SessionPermission {
  readonly permission: string;
  readonly pattern: string;
  readonly action: "allow" | "deny" | "ask";
}

/** POST /session body. */
export interface CreateSessionRequest {
  readonly title: string;
  readonly permission: readonly SessionPermission[];
  readonly model?: { readonly providerID: string; readonly id: string };
}

export interface TextPartInput {
  readonly type: "text";
  readonly text: string;
}

/** POST /session/{id}/prompt_async body. */
export interface PromptAsyncRequest {
  readonly model?: { readonly providerID: string; readonly modelID: string };
  readonly parts: readonly TextPartInput[];
}
