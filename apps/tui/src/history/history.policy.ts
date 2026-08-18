import type {
  GitHubMerge,
  HistoryEvent,
  HistoryMergeRow,
  HistoryOverview,
  HistoryProjectRow,
} from "./history.interface";

const DAY_MS = 24 * 60 * 60 * 1000;
const LANDING = "score.landing.decision";

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function inRange(timestamp: string, startMs: number, endExclusiveMs: number): number | null {
  const instant = Date.parse(timestamp);
  return Number.isNaN(instant) || instant < startMs || instant >= endExclusiveMs ? null : instant;
}

/** Calendar-day history: GitHub owns merge facts; daemon events are a fallback. */
export function historyOverview(
  events: readonly HistoryEvent[],
  projects: readonly string[],
  endDay: string,
  days: 7 | 30,
  githubMerges: readonly GitHubMerge[] = [],
): HistoryOverview {
  const endMs = dayStart(endDay);
  const startMs = endMs - (days - 1) * DAY_MS;
  const endExclusiveMs = endMs + DAY_MS;
  const recentByPullRequest = new Map<string, HistoryMergeRow>();

  for (const merge of githubMerges) {
    if (inRange(merge.mergedTs, startMs, endExclusiveMs) === null) continue;
    recentByPullRequest.set(`${merge.project}:${merge.pullRequest}`, {
      project: merge.project,
      pullRequest: merge.pullRequest,
      mergedTs: merge.mergedTs,
      title: merge.title,
    });
  }

  for (const event of events) {
    if (
      event.attributes?.dry_run === true ||
      event.name !== LANDING ||
      event.attributes?.tag !== "merged" ||
      inRange(event.ts, startMs, endExclusiveMs) === null
    ) {
      continue;
    }
    const pullRequest = event.subject?.pull_request_number;
    if (pullRequest === undefined) continue;
    const key = `${event.project}:${pullRequest}`;
    if (!recentByPullRequest.has(key)) {
      recentByPullRequest.set(key, {
        project: event.project,
        pullRequest,
        mergedTs: event.ts,
        title: null,
      });
    }
  }

  const recent = [...recentByPullRequest.values()].sort(
    (a, b) => Date.parse(b.mergedTs) - Date.parse(a.mergedTs),
  );
  const mergesByDay = Array.from({ length: days }, () => 0);
  for (const merge of recent) {
    const instant = Date.parse(merge.mergedTs);
    const index = Math.floor((instant - startMs) / DAY_MS);
    mergesByDay[index] = (mergesByDay[index] ?? 0) + 1;
  }

  const projectKeys = new Set([...projects, ...recent.map((row) => row.project)]);
  const byProject: HistoryProjectRow[] = [...projectKeys]
    .map((project) => {
      const merges = recent.filter((row) => row.project === project);
      return {
        project,
        merged: merges.length,
        share: recent.length === 0 ? null : merges.length / recent.length,
        latestTs: merges[0]?.mergedTs ?? null,
      };
    })
    .sort((a, b) => b.merged - a.merged || a.project.localeCompare(b.project));

  return {
    merged: recent.length,
    activeProjects: byProject.filter((row) => row.merged > 0).length,
    busiestDay: Math.max(0, ...mergesByDay),
    latestTs: recent[0]?.mergedTs ?? null,
    startDay: new Date(startMs).toISOString().slice(0, 10),
    endDay,
    mergesByDay,
    byProject,
    recent,
  };
}
