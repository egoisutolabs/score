/**
 * Client-side fold over streamed telemetry decision events: the console's
 * activity truth. Pure decisions only — no I/O and no clock reads; callers
 * pass `nowMs`. The vocabulary mirrors the daemon's telemetry.render.ts;
 * a record this module does not recognize is left out, never guessed at.
 */

/** Who a streamed record is about — copied verbatim from the wire shape. */
export interface DecisionSubject {
  readonly session?: string;
  readonly branch?: string;
  readonly issue_number?: number;
  readonly pull_request_number?: number;
}

/** One streamed telemetry event, as `/api/v1/stream` delivers it. */
export interface DecisionEvent {
  readonly project: string;
  /** RFC 3339; ordering decisions parse it rather than string-compare it. */
  readonly ts: string;
  readonly name: string;
  readonly subject?: DecisionSubject;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: string;
}

// Exact names gate every fold below: `score.<phase>.unknown` records and any
// foreign name fall through untouched — the console renders only vocabulary
// it understands.
const DISPATCH = "score.dispatch.decision";
const LANDING = "score.landing.decision";
const REPAIR = "score.repair.decision";
const CLEANUP = "score.cleanup.decision";

/** Landing tags most-troubled-first; openPrs sorts by index into this list. */
export const TROUBLE_RANK: readonly string[] = [
  "push-failed",
  "conflict",
  "build-red",
  "checks-red",
  "changes-requested",
  "unresolved",
  "checks-pending",
  "soaking",
  "would-merge",
  "ready",
  "skipped",
];

export interface LandingState {
  readonly tag: string;
  readonly ts: string;
}

export interface RepairState {
  readonly action: string;
  readonly ts: string;
}

export interface PrActivity {
  readonly landing?: LandingState;
  readonly repair?: RepairState;
}

export interface IssueActivity {
  readonly decision: string;
  readonly reason?: string;
  readonly ts: string;
}

export interface ProjectFold {
  readonly prs: Map<number, PrActivity>;
  readonly issues: Map<number, IssueActivity>;
}

// A dry-run pass rehearses phase outcomes without acting on them, so its
// records describe hypotheticals — letting them through would overwrite the
// console's real state with rehearsal data. Applied everywhere in this
// module, not just in the fold.
function isLive(event: DecisionEvent, project: string): boolean {
  return event.project === project && event.attributes?.dry_run !== true;
}

// Array order breaks timestamp ties (later wins), so a same-second
// correction replayed in stream order lands on the corrected value.
function supersedes(candidateTs: string, incumbentTs: string | undefined): boolean {
  return incumbentTs === undefined || Date.parse(candidateTs) >= Date.parse(incumbentTs);
}

/** Latest-per-subject state for one project: PRs by landing/repair, issues by dispatch decision. */
export function foldProject(events: readonly DecisionEvent[], project: string): ProjectFold {
  const prs = new Map<number, PrActivity>();
  const issues = new Map<number, IssueActivity>();
  for (const event of events) {
    if (!isLive(event, project)) continue;
    if (event.name === LANDING) {
      const number = event.subject?.pull_request_number;
      const tag = event.attributes?.tag;
      if (number === undefined || typeof tag !== "string") continue;
      const current = prs.get(number);
      if (supersedes(event.ts, current?.landing?.ts))
        prs.set(number, { ...current, landing: { tag, ts: event.ts } });
    } else if (event.name === REPAIR) {
      const number = event.subject?.pull_request_number;
      const action = event.attributes?.action;
      if (number === undefined || typeof action !== "string") continue;
      const current = prs.get(number);
      if (supersedes(event.ts, current?.repair?.ts))
        prs.set(number, { ...current, repair: { action, ts: event.ts } });
    } else if (event.name === DISPATCH) {
      const number = event.subject?.issue_number;
      const decision = event.attributes?.decision;
      if (number === undefined || typeof decision !== "string") continue;
      if (supersedes(event.ts, issues.get(number)?.ts)) {
        const reason = event.attributes?.reason;
        issues.set(number, {
          decision,
          ts: event.ts,
          ...(typeof reason === "string" && { reason }),
        });
      }
    }
  }
  return { prs, issues };
}

/** A card headlines the landing tag; repair rides along only while it means someone is on it. */
const ACTIVE_REPAIR: ReadonlySet<string> = new Set(["PINGED", "SPAWNED", "WORKING"]);

export interface OpenPrCard {
  readonly number: number;
  readonly tag: string;
  readonly tagTs: string;
  readonly repair?: RepairState;
}

// A tag outside TROUBLE_RANK ranks past the end: unrecognized is not the
// same as maximally troubled.
function troubleIndex(tag: string): number {
  const index = TROUBLE_RANK.indexOf(tag);
  return index === -1 ? TROUBLE_RANK.length : index;
}

/** Unmerged PRs, most-troubled-first; ties go to the higher PR number. */
export function openPrs(fold: ProjectFold): OpenPrCard[] {
  const cards: OpenPrCard[] = [];
  for (const [number, state] of fold.prs) {
    // A PR with repair activity but no landing tag yet has no truthful
    // headline, so it gets no card rather than an invented one.
    if (state.landing === undefined || state.landing.tag === "merged") continue;
    const repair = state.repair;
    cards.push({
      number,
      tag: state.landing.tag,
      tagTs: state.landing.ts,
      ...(repair !== undefined && ACTIVE_REPAIR.has(repair.action) && { repair }),
    });
  }
  cards.sort((a, b) => troubleIndex(a.tag) - troubleIndex(b.tag) || b.number - a.number);
  return cards;
}

export interface ActivityTiles {
  readonly prsOpen: number;
  readonly stuck: number;
  readonly merged24h: number;
  readonly issuesBlocked: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Tags at or above "unresolved" in trouble rank need a human; below it the
// pipeline is merely waiting.
const STUCK_THRESHOLD = TROUBLE_RANK.indexOf("unresolved");

/** Headline numbers for one project's tile row. */
export function tiles(
  events: readonly DecisionEvent[],
  project: string,
  nowMs: number,
): ActivityTiles {
  const fold = foldProject(events, project);
  let prsOpen = 0;
  let stuck = 0;
  for (const state of fold.prs.values()) {
    if (state.landing === undefined || state.landing.tag === "merged") continue;
    prsOpen += 1;
    const index = TROUBLE_RANK.indexOf(state.landing.tag);
    if (index !== -1 && index <= STUCK_THRESHOLD) stuck += 1;
  }
  let issuesBlocked = 0;
  for (const state of fold.issues.values()) if (state.decision === "blocked") issuesBlocked += 1;
  // Counts merge events, not fold state: the fold keeps one tag per PR, but
  // this tile answers "how many merges happened". Window is (nowMs-24h, nowMs].
  let merged24h = 0;
  for (const event of events) {
    if (!isLive(event, project) || event.name !== LANDING) continue;
    if (event.attributes?.tag !== "merged") continue;
    const tsMs = Date.parse(event.ts);
    if (tsMs > nowMs - DAY_MS && tsMs <= nowMs) merged24h += 1;
  }
  return { prsOpen, stuck, merged24h, issuesBlocked };
}

export interface MergeDayBucket {
  readonly day: string;
  readonly count: number;
}

/** The UTC calendar day (YYYY-MM-DD) of an epoch-ms instant. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Merge counts per UTC day, oldest→newest, zero-filled; the newest bucket is nowMs's day. */
export function mergesPerDay(
  events: readonly DecisionEvent[],
  project: string,
  days: number,
  nowMs: number,
): MergeDayBucket[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!isLive(event, project) || event.name !== LANDING) continue;
    if (event.attributes?.tag !== "merged") continue;
    const tsMs = Date.parse(event.ts);
    if (Number.isNaN(tsMs)) continue;
    const day = utcDay(tsMs);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const buckets: MergeDayBucket[] = [];
  // UTC days are a uniform 86 400 000 ms, so stepping in DAY_MS multiples
  // crosses month boundaries correctly without calendar arithmetic.
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = utcDay(nowMs - i * DAY_MS);
    buckets.push({ day, count: counts.get(day) ?? 0 });
  }
  return buckets;
}

/** Per-project merge buckets, one zero-filled `mergesPerDay` series per requested project. */
export function mergesPerDayByProject(
  events: readonly DecisionEvent[],
  projects: readonly string[],
  days: number,
  nowMs: number,
): Map<string, MergeDayBucket[]> {
  const series = new Map<string, MergeDayBucket[]>();
  for (const project of projects) series.set(project, mergesPerDay(events, project, days, nowMs));
  return series;
}

/**
 * One merged PR and how long landing was observed watching it. `spanMs` is
 * merge ts minus the first landing decision (any tag) seen for the PR in the
 * event buffer — "time in landing observation", NOT time-to-merge: the buffer
 * may begin mid-flight, so the first observed event only bounds when landing
 * actually started. The UI labels this "landing → merge". Null when the merge
 * is the only landing event seen for the PR.
 */
export interface LandingSpan {
  readonly number: number;
  readonly project: string;
  readonly mergedTs: string;
  readonly spanMs: number | null;
}

/** Merges within (sinceMs, nowMs] with their observation spans, newest first. */
export function landingSpans(
  events: readonly DecisionEvent[],
  project: string,
  sinceMs: number,
  nowMs: number,
): LandingSpan[] {
  // The span starts at the earliest landing event in the whole buffer, not
  // the window: the window bounds which merges count, not their history.
  const firstSeenMs = new Map<number, number>();
  const landingSeen = new Map<number, number>();
  for (const event of events) {
    if (!isLive(event, project) || event.name !== LANDING) continue;
    const number = event.subject?.pull_request_number;
    if (number === undefined) continue;
    const tsMs = Date.parse(event.ts);
    if (Number.isNaN(tsMs)) continue;
    landingSeen.set(number, (landingSeen.get(number) ?? 0) + 1);
    const current = firstSeenMs.get(number);
    if (current === undefined || tsMs < current) firstSeenMs.set(number, tsMs);
  }
  const spans: LandingSpan[] = [];
  for (const event of events) {
    if (!isLive(event, project) || event.name !== LANDING) continue;
    if (event.attributes?.tag !== "merged") continue;
    const number = event.subject?.pull_request_number;
    if (number === undefined) continue;
    const mergedMs = Date.parse(event.ts);
    if (Number.isNaN(mergedMs) || mergedMs <= sinceMs || mergedMs > nowMs) continue;
    const first = firstSeenMs.get(number);
    // A lone merge event has no observed history to span.
    const spanMs =
      first === undefined || (landingSeen.get(number) ?? 0) < 2 ? null : mergedMs - first;
    spans.push({ number, project, mergedTs: event.ts, spanMs });
  }
  spans.sort((a, b) => Date.parse(b.mergedTs) - Date.parse(a.mergedTs));
  return spans;
}

/** Median over the non-null spans; null when every span is null or the list is empty. */
export function medianSpanMs(spans: readonly LandingSpan[]): number | null {
  const values = spans
    .map((span) => span.spanMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

export interface HistoryStats {
  readonly merged: number;
  readonly medianSpanMs: number | null;
  readonly mergedWithoutRepair: number;
  readonly repairPings: number;
}

/** Headline numbers for the History tab; merges and pings windowed to (sinceMs, nowMs]. */
export function historyStats(
  events: readonly DecisionEvent[],
  project: string,
  sinceMs: number,
  nowMs: number,
): HistoryStats {
  const spans = landingSpans(events, project, sinceMs, nowMs);
  // Repair history is judged over the whole buffer, not the window: a PR
  // repaired before the window still did not merge unassisted. Only ACTIVE
  // repair actions count as "repaired" — the daemon also emits a routine
  // NOT_NEEDED decision for every healthy PR every pass, and counting those
  // would mark the entire fleet repaired.
  const repairedPrs = new Set<number>();
  let repairPings = 0;
  for (const event of events) {
    if (!isLive(event, project) || event.name !== REPAIR) continue;
    const number = event.subject?.pull_request_number;
    const action = event.attributes?.action;
    if (number !== undefined && typeof action === "string" && ACTIVE_REPAIR.has(action)) {
      repairedPrs.add(number);
    }
    if (action === "PINGED") {
      const tsMs = Date.parse(event.ts);
      if (tsMs > sinceMs && tsMs <= nowMs) repairPings += 1;
    }
  }
  let mergedWithoutRepair = 0;
  for (const span of spans) if (!repairedPrs.has(span.number)) mergedWithoutRepair += 1;
  return {
    merged: spans.length,
    medianSpanMs: medianSpanMs(spans),
    mergedWithoutRepair,
    repairPings,
  };
}

/** Fleet-wide merges on nowMs's UTC day — the header's "merged today". */
export function mergedTodayFleet(events: readonly DecisionEvent[], nowMs: number): number {
  const today = utcDay(nowMs);
  let count = 0;
  for (const event of events) {
    if (event.attributes?.dry_run === true || event.name !== LANDING) continue;
    if (event.attributes?.tag !== "merged") continue;
    const tsMs = Date.parse(event.ts);
    if (!Number.isNaN(tsMs) && utcDay(tsMs) === today) count += 1;
  }
  return count;
}

export interface FeedRow {
  readonly ts: string;
  readonly kind: string;
  readonly text: string;
}

function subjectLabel(subject: DecisionSubject | undefined): string {
  if (subject?.pull_request_number !== undefined) return `#${subject.pull_request_number}`;
  if (subject?.issue_number !== undefined) return `issue ${subject.issue_number}`;
  return subject?.session ?? "";
}

// STRANDED_RECLAIMED reads as "reclaimed": the stranded qualifier restates
// what the subject already conveys, and underscores are enum syntax, not
// prose.
function cleanupWord(action: string): string {
  return action
    .toLowerCase()
    .replace(/^stranded_/, "")
    .replace(/_/g, " ");
}

// Returns undefined when the event lacks the attribute its phase keys on —
// a row with a blank verb would be invented data.
function feedRow(event: DecisionEvent): FeedRow | undefined {
  const attributes = event.attributes;
  let kind: string;
  let word: string;
  const details: string[] = [];
  if (event.name === DISPATCH) {
    const decision = attributes?.decision;
    if (typeof decision !== "string") return undefined;
    // "started" is the phase doing its one job, so the row reads as the
    // phase name; the other decisions are the interesting word themselves.
    kind = decision === "started" ? "dispatch" : decision;
    word = decision;
    const reason = attributes?.reason;
    if (decision === "blocked" && typeof reason === "string") details.push(reason);
  } else if (event.name === LANDING) {
    const tag = attributes?.tag;
    if (typeof tag !== "string") return undefined;
    kind = tag;
    word = tag;
  } else if (event.name === REPAIR) {
    const action = attributes?.action;
    if (typeof action !== "string") return undefined;
    kind = "repair";
    word = action.toLowerCase().replace(/_/g, " ");
  } else if (event.name === CLEANUP) {
    const action = attributes?.action;
    if (typeof action !== "string") return undefined;
    kind = "cleanup";
    word = cleanupWord(action);
  } else {
    return undefined;
  }
  if (event.body !== undefined) details.push(event.body);
  const label = subjectLabel(event.subject);
  const head = label === "" ? word : `${label} ${word}`;
  return {
    ts: event.ts,
    kind,
    text: details.length === 0 ? head : `${head} — ${details.join(" — ")}`,
  };
}

/** Newest-first terse activity lines, capped at `limit`. */
export function feedRows(
  events: readonly DecisionEvent[],
  project: string,
  limit: number,
): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const event of events) {
    if (!isLive(event, project)) continue;
    const built = feedRow(event);
    if (built !== undefined) rows.push(built);
  }
  // sort() is stable, so equal timestamps keep stream order after the flip.
  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return rows.slice(0, limit);
}
