/**
 * The stream's filter grammar (#81): enumerated params, exact-match and
 * time-window semantics only — no wildcards, regex, or full-text, by
 * ceiling. Parsing and record matching are pure decisions; reading files is
 * replay.service.ts's job.
 */

import type { TelemetryRecord } from "@score/core/telemetry/telemetry.interface";
import { METRIC_LABELS } from "@score/core/telemetry/telemetry.interface";
import { isRfc3339 } from "@score/core/telemetry/telemetry.policy";

/** What a subscription can select; `snapshot` and `log` are stream-only kinds. */
export const STREAM_SIGNALS = ["snapshot", "event", "span", "metric", "log"] as const;
export type StreamSignal = (typeof STREAM_SIGNALS)[number];

export const SUBJECT_KINDS = ["issue", "pull_request", "session", "branch"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

type Phase = (typeof METRIC_LABELS.phase)[number];
type Outcome = (typeof METRIC_LABELS.outcome)[number];

/** An absent field matches everything; every present field narrows. */
export interface StreamQuery {
  readonly projects?: readonly string[];
  readonly signals?: readonly StreamSignal[];
  readonly names?: readonly string[];
  readonly phases?: readonly Phase[];
  readonly outcomes?: readonly Outcome[];
  readonly traceId?: string;
  readonly subject?: { readonly kind: SubjectKind; readonly id: string };
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly follow: boolean;
}

export type QueryParseResult =
  | { readonly ok: true; readonly query: StreamQuery }
  | { readonly ok: false; readonly reason: "FILTER_UNKNOWN" | "FILTER_INVALID" };

const KNOWN_PARAMS: ReadonlySet<string> = new Set([
  "projects",
  "signals",
  "names",
  "phases",
  "outcomes",
  "trace_id",
  "subject_kind",
  "subject_id",
  "since",
  "until",
  "follow",
]);

const INVALID: QueryParseResult = { ok: false, reason: "FILTER_INVALID" };

export function parseStreamQuery(params: URLSearchParams): QueryParseResult {
  for (const key of params.keys()) {
    if (!KNOWN_PARAMS.has(key)) return { ok: false, reason: "FILTER_UNKNOWN" };
  }
  // Comma-separated and repeated params both accumulate; an empty item
  // (`projects=`) names nothing exactly, so it is invalid rather than a
  // silent match-all.
  const list = (name: string): readonly string[] | undefined => {
    const values = params.getAll(name).flatMap((value) => value.split(","));
    return values.length === 0 ? undefined : values;
  };
  const enums = <T extends string>(
    name: string,
    allowed: readonly T[],
  ): readonly T[] | undefined | "INVALID" => {
    const values = list(name);
    if (values === undefined) return undefined;
    return values.every((value): value is T => (allowed as readonly string[]).includes(value))
      ? (values as readonly T[])
      : "INVALID";
  };
  const time = (name: string): number | undefined | "INVALID" => {
    const value = params.get(name);
    if (value === null) return undefined;
    // The record-timestamp bar (#74): shape and calendar ranges both —
    // Date.parse alone would normalize 2026-02-30 into March.
    if (!isRfc3339(value)) return "INVALID";
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? "INVALID" : ms;
  };

  const projects = list("projects");
  const names = list("names");
  if (projects?.includes("") || names?.includes("")) return INVALID;
  const signals = enums("signals", STREAM_SIGNALS);
  const phases = enums("phases", METRIC_LABELS.phase);
  const outcomes = enums("outcomes", METRIC_LABELS.outcome);
  if (signals === "INVALID" || phases === "INVALID" || outcomes === "INVALID") return INVALID;
  const traceId = params.get("trace_id") ?? undefined;
  if (traceId === "") return INVALID;

  const subjectKind = params.get("subject_kind");
  const subjectId = params.get("subject_id");
  // The pair addresses one subject; half a pair narrows to nothing knowable.
  if ((subjectKind === null) !== (subjectId === null)) return INVALID;
  let subject: StreamQuery["subject"];
  if (subjectKind !== null && subjectId !== null) {
    if (!(SUBJECT_KINDS as readonly string[]).includes(subjectKind) || subjectId === "") {
      return INVALID;
    }
    subject = { kind: subjectKind as SubjectKind, id: subjectId };
  }

  const sinceMs = time("since");
  const untilMs = time("until");
  if (sinceMs === "INVALID" || untilMs === "INVALID") return INVALID;

  const follow = params.get("follow");
  if (follow !== null && follow !== "true" && follow !== "false") return INVALID;

  return {
    ok: true,
    query: {
      ...(projects && { projects }),
      ...(signals && { signals }),
      ...(names && { names }),
      ...(phases && { phases }),
      ...(outcomes && { outcomes }),
      ...(traceId !== undefined && { traceId }),
      ...(subject && { subject }),
      ...(sinceMs !== undefined && { sinceMs }),
      ...(untilMs !== undefined && { untilMs }),
      // The epic's default is a stream that stays open; this PR closes it at
      // the seam either way, but the default still selects the warning path.
      follow: follow !== "false",
    },
  };
}

export function wantsSignal(query: StreamQuery, signal: StreamSignal): boolean {
  return query.signals === undefined || query.signals.includes(signal);
}

/** A parsed dated-log line; the prose text is the whole payload. */
export interface StreamLogRecord {
  readonly project: string;
  readonly ts: string;
  readonly level: string;
  readonly body: string;
}

export function matchesTelemetry(query: StreamQuery, record: TelemetryRecord): boolean {
  if (!wantsSignal(query, record.signal)) return false;
  if (query.names !== undefined && !query.names.includes(record.name)) return false;
  if (query.phases !== undefined) {
    const phase = phaseOf(record);
    if (phase === undefined || !query.phases.includes(phase)) return false;
  }
  if (query.outcomes !== undefined) {
    const outcome = outcomeOf(record);
    if (outcome === undefined || !query.outcomes.includes(outcome)) return false;
  }
  if (query.traceId !== undefined && record.attributes?.trace_id !== query.traceId) return false;
  if (query.subject !== undefined && !subjectMatches(query.subject, record.subject)) return false;
  return inWindow(query, record.ts);
}

/**
 * Prose lines carry no name, phase, outcome, trace, or subject — a filter on
 * any of those excludes the log source entirely rather than guessing from
 * free text (the no-full-text ceiling).
 */
export function matchesLog(query: StreamQuery, record: StreamLogRecord): boolean {
  if (!wantsSignal(query, "log")) return false;
  if (
    query.names !== undefined ||
    query.phases !== undefined ||
    query.outcomes !== undefined ||
    query.traceId !== undefined ||
    query.subject !== undefined
  ) {
    return false;
  }
  return inWindow(query, record.ts);
}

function inWindow(query: StreamQuery, ts: string): boolean {
  if (query.sinceMs === undefined && query.untilMs === undefined) return true;
  const ms = Date.parse(ts);
  // An unparseable timestamp has no place in any window.
  if (Number.isNaN(ms)) return false;
  return (
    (query.sinceMs === undefined || ms >= query.sinceMs) &&
    (query.untilMs === undefined || ms <= query.untilMs)
  );
}

/** Spans carry `attributes.phase`, metrics `labels.phase`, decision events their name's segment. */
function phaseOf(record: TelemetryRecord): Phase | undefined {
  const declared = record.signal === "metric" ? record.labels?.phase : record.attributes?.phase;
  if (typeof declared === "string" && isPhase(declared)) return declared;
  const segment = record.name.split(".")[1];
  return segment !== undefined && isPhase(segment) ? segment : undefined;
}

function isPhase(value: string): value is Phase {
  return (METRIC_LABELS.phase as readonly string[]).includes(value);
}

/** Spans have `status`, metrics `labels.outcome`; events carry no outcome. */
function outcomeOf(record: TelemetryRecord): Outcome | undefined {
  if (record.signal === "span") return record.status;
  if (record.signal === "metric") return record.labels?.outcome;
  return undefined;
}

function subjectMatches(
  filter: NonNullable<StreamQuery["subject"]>,
  subject: TelemetryRecord["subject"],
): boolean {
  if (subject === undefined) return false;
  switch (filter.kind) {
    case "issue":
      return subject.issue_number !== undefined && String(subject.issue_number) === filter.id;
    case "pull_request":
      return (
        subject.pull_request_number !== undefined &&
        String(subject.pull_request_number) === filter.id
      );
    case "session":
      return subject.session === filter.id;
    case "branch":
      return subject.branch === filter.id;
  }
}
