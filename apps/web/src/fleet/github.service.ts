import { checkRollup } from "@score/core/landing/landing.policy";
import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import { resolvedPath } from "@score/shared/config/layout";
import { GitHubService } from "@score/tracker/github.service";
import { readResolvedView } from "./snapshot.service";

/** One open PR as the console renders it: the mock's three verdict rows. */
export interface GithubPrJson {
  readonly number: number;
  readonly title: string;
  readonly isDraft: boolean;
  /** gh's own vocabulary: MERGEABLE | CONFLICTING | UNKNOWN. */
  readonly mergeable: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (no reviewers). */
  readonly reviewDecision: string | null;
  readonly checksFailing: number;
  readonly checksPending: number;
  readonly checksTotal: number;
}

export interface GithubJson {
  readonly prs: readonly GithubPrJson[];
  readonly openIssues: number;
  /** RFC 3339 — the console shows cached observations honestly aged. */
  readonly fetchedAt: string;
}

/** Thrown when resolved.json lacks the repo/path a gh call needs. */
export class GithubUnconfiguredError extends Error {}

/**
 * Live GitHub reads stay expensive (two gh calls), and the console polls its
 * routes aggressively — one observation per project per TTL, with concurrent
 * requests coalescing onto the in-flight promise. A failed observation is
 * evicted so the next poll retries instead of caching the outage.
 */
const TTL_MS = 30_000;
const GH_TIMEOUT_MS = 20_000;
const cache = new Map<string, { readonly at: number; readonly promise: Promise<GithubJson> }>();

type Observer = (key: string) => Promise<GithubJson>;
let observerOverride: Observer | null = null;

/** Test seam: routes must never shell out to gh in a test run. */
export function setGithubObserver(observer: Observer | null): void {
  observerOverride = observer;
  cache.clear();
}

async function observe(key: string): Promise<GithubJson> {
  const resolved = await readResolvedView(resolvedPath(key));
  if (resolved === null || resolved.repo === null || resolved.mainLocation === null) {
    throw new GithubUnconfiguredError(`'${key}' has no resolved repo/path — run: score up ${key}`);
  }
  // The daemon's own adapter, read-only methods only: the console must never
  // grow a second GitHub vocabulary (or any mutating call).
  const github = new GitHubService(new BunCommandRunner(), {
    repositoryPath: resolved.mainLocation,
    repository: resolved.repo,
    timeoutMs: GH_TIMEOUT_MS,
  });
  const [changes, issues] = await Promise.all([
    github.observeOpenChanges(),
    github.observeIssues(),
  ]);
  return {
    prs: changes.map((change) => {
      const rollup = checkRollup(change);
      return {
        number: change.number,
        title: change.title,
        isDraft: change.isDraft,
        mergeable: change.mergeable,
        reviewDecision: change.reviewDecision,
        checksFailing: rollup.failing,
        checksPending: rollup.pending,
        checksTotal: change.statusCheckRollup.length,
      };
    }),
    openIssues: issues.length,
    fetchedAt: new Date().toISOString(),
  };
}

export function observeGithub(key: string): Promise<GithubJson> {
  if (observerOverride !== null) return observerOverride(key);
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < TTL_MS) return cached.promise;
  const promise = observe(key);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    // Evict only our own entry — a concurrent refresh may have replaced it.
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}
