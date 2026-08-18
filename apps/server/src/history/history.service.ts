import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { loadConfig } from "@score/shared/config/load";
import { expandTilde } from "@score/shared/config/resolve";
import { type GitHubMergeHistory, GitHubService } from "@score/tracker/github.service";
import type { GitHubMergeView, HistoryOutcome } from "./history.interface";

const CACHE_MS = 30_000;
const GITHUB_TIMEOUT_MS = 15_000;

export interface HistoryProject {
  readonly key: string;
  readonly repositoryPath: string;
  readonly repository: string;
}

export interface HistoryDependencies {
  readonly loadProjects: () => Promise<readonly HistoryProject[]>;
  readonly observeMerges: (
    project: HistoryProject,
    sinceMs: number,
  ) => Promise<readonly GitHubMergeHistory[]>;
  readonly now: () => number;
  readonly cacheMs: number;
}

interface HistoryCache {
  readonly sinceMs: number;
  readonly expiresAt: number;
  readonly outcome: Promise<HistoryOutcome>;
}

export function defaultHistoryDependencies(): HistoryDependencies {
  const runner = new BunCommandRunner({ defaultTimeoutMs: GITHUB_TIMEOUT_MS });
  return {
    loadProjects: async () => projectsFromConfig(await loadConfig()),
    observeMerges: (project, sinceMs) =>
      new GitHubService(runner, {
        repositoryPath: project.repositoryPath,
        repository: project.repository,
        timeoutMs: GITHUB_TIMEOUT_MS,
      }).observeMergeHistory(new Date(sinceMs).toISOString().slice(0, 10)),
    now: Date.now,
    cacheMs: CACHE_MS,
  };
}

/** Cached, read-only GitHub observations for the server's history endpoint. */
export class HistoryService {
  #cache: HistoryCache | null = null;

  constructor(private readonly deps: HistoryDependencies = defaultHistoryDependencies()) {}

  observe(sinceMs: number): Promise<HistoryOutcome> {
    const now = this.deps.now();
    if (this.#cache !== null && this.#cache.sinceMs === sinceMs && this.#cache.expiresAt > now) {
      return this.#cache.outcome;
    }
    const outcome = this.#load(sinceMs);
    this.#cache = { sinceMs, expiresAt: now + this.deps.cacheMs, outcome };
    return outcome;
  }

  async #load(sinceMs: number): Promise<HistoryOutcome> {
    let projects: readonly HistoryProject[];
    try {
      projects = await this.deps.loadProjects();
    } catch {
      return { kind: "error", status: 503, reason: "CONFIG_UNPARSEABLE" };
    }

    const observations = await Promise.allSettled(
      projects.map(async (project) => ({
        project,
        merges: await this.deps.observeMerges(project, sinceMs),
      })),
    );
    const merges: GitHubMergeView[] = [];
    let unavailable = false;
    for (const observation of observations) {
      if (observation.status === "rejected") {
        unavailable = true;
        continue;
      }
      for (const merge of observation.value.merges) {
        const mergedAt = Date.parse(merge.mergedAt);
        if (Number.isNaN(mergedAt) || mergedAt < sinceMs) continue;
        merges.push({
          project: observation.value.project.key,
          pull_request_number: merge.number,
          title: merge.title,
          merged_at: merge.mergedAt,
        });
      }
    }
    merges.sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
    return {
      kind: "ok",
      merges,
      warnings: unavailable ? [{ reason: "GITHUB_UNAVAILABLE" }] : [],
    };
  }
}

function projectsFromConfig(config: ScoreConfig): readonly HistoryProject[] {
  return Object.entries(config.projects).map(([key, project]) => ({
    key,
    repositoryPath: expandTilde(project.main_location),
    repository: project.github_repo,
  }));
}
