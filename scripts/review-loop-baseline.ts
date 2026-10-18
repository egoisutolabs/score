#!/usr/bin/env bun
/**
 * Review-loop baseline from GitHub review threads, for repos that predate the
 * repair-loop telemetry. Reproduces docs/review-loop-baseline.md:
 *
 *   bun scripts/review-loop-baseline.ts egoisutolabs/score --prs 71,85,86,...
 *   bun scripts/review-loop-baseline.ts gendev1/marvelous-monkey --since 2026-08-01
 *
 * A "finding" is a review thread whose root comment a bot reviewer wrote. A
 * "round" is a distinct commit a bot reviewer submitted a review on. The
 * "late" share counts findings opened in round two or later; "regress" counts
 * findings whose cited commit is not the PR's first commit (an upper bound on
 * regression-from-fix: blame-keyed classification is the ledger's job).
 * "self-resolved" is any thread a non-bot login resolved — the agent runs on
 * the human's gh token, so the two are indistinguishable here.
 *
 * Needs `gh` authenticated. Read-only.
 */
import { isReviewerBot } from "../packages/core/src/repair/findings/finding.policy";

interface Review {
  readonly state: string;
  readonly commit_id: string;
  /** null once the author's account is deleted. */
  readonly user: { readonly login: string } | null;
}
interface Commit {
  readonly sha: string;
}
interface ThreadComment {
  readonly author: { readonly login: string } | null;
  readonly originalCommit: { readonly oid: string } | null;
  readonly commit: { readonly oid: string } | null;
}
interface Thread {
  readonly isResolved: boolean;
  readonly resolvedBy: { readonly login: string } | null;
  readonly comments: { readonly nodes: readonly ThreadComment[] };
}
interface ThreadsResponse {
  readonly data: {
    readonly repository: {
      readonly pullRequest: {
        readonly mergedAt: string | null;
        readonly reviewThreads: {
          readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
          readonly nodes: readonly Thread[];
        };
      };
    };
  };
}

const [repo, ...rest] = process.argv.slice(2);
if (!repo?.includes("/")) {
  console.error("usage: bun scripts/review-loop-baseline.ts owner/repo [--prs a,b,c] [--since YYYY-MM-DD]");
  process.exit(2);
}
const [owner, name] = repo.split("/") as [string, string];
const arg = (flag: string) => {
  const i = rest.indexOf(flag);
  return i === -1 ? undefined : rest[i + 1];
};

async function gh(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed: ${err.trim()}`);
  return out;
}
const api = async <T>(path: string): Promise<T> =>
  JSON.parse(await gh(["api", path, "--paginate", "--slurp"])).flat() as T;

// The ledger's own predicate, so the baseline and the live figures agree on
// what a bot is; an unnamed root author (deleted account) is not one.
const isBot = isReviewerBot;

async function prNumbers(): Promise<number[]> {
  const explicit = arg("--prs");
  if (explicit) return explicit.split(",").map(Number);
  const since = arg("--since") ?? "1970-01-01";
  // `gh pr list --limit` is a cap, not a page: newest first, so the list is
  // complete only once it reaches a PR older than the cutoff or runs out.
  let limit = 200;
  for (;;) {
    const list = JSON.parse(
      await gh(["pr", "list", "-R", repo, "--state", "all", "--limit", String(limit), "--json", "number,createdAt"]),
    ) as { number: number; createdAt: string }[];
    const oldest = list.at(-1)?.createdAt;
    if (list.length < limit || (oldest !== undefined && oldest < since)) {
      return list.filter((p) => p.createdAt >= since).map((p) => p.number).sort((a, b) => a - b);
    }
    limit *= 2;
  }
}

const THREADS_QUERY = `query($n:Int!,$cursor:String){repository(owner:"${owner}",name:"${name}"){pullRequest(number:$n){mergedAt reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{isResolved resolvedBy{login} comments(first:1){nodes{author{login} originalCommit{oid} commit{oid}}}}}}}}`;

/** Every review thread of a PR, following the connection to its end so a 100+ thread PR is not folded in truncated. */
async function allThreads(n: number): Promise<{ mergedAt: string | null; threads: Thread[] }> {
  const threads: Thread[] = [];
  let cursor: string | null = null;
  let mergedAt: string | null = null;
  do {
    const args = ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `n=${n}`];
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    const pr = (JSON.parse(await gh(args)) as ThreadsResponse).data.repository.pullRequest;
    mergedAt = pr.mergedAt;
    threads.push(...pr.reviewThreads.nodes);
    cursor = pr.reviewThreads.pageInfo.hasNextPage ? pr.reviewThreads.pageInfo.endCursor : null;
  } while (cursor !== null);
  return { mergedAt, threads };
}

const totals = { prs: 0, rounds: 0, threads: 0, late: 0, regress: 0, selfResolved: 0, openAtMerge: 0 };
const reviewers = new Map<string, number>();
console.log("PR    commits rounds threads late regress selfRes unresolvedNow  by_round");
for (const n of await prNumbers()) {
  const pr = await allThreads(n);
  const threads = pr.threads.filter((t) => isBot(t.comments.nodes[0]?.author?.login));
  if (threads.length === 0) continue;
  const commits = await api<Commit[]>(`repos/${repo}/pulls/${n}/commits`);
  const reviews = await api<Review[]>(`repos/${repo}/pulls/${n}/reviews`);
  const shas = commits.map((c) => c.sha);
  const botReviews = reviews.filter((r) => r.state !== "PENDING" && isBot(r.user?.login));
  for (const r of botReviews) {
    const login = r.user?.login ?? "unknown";
    reviewers.set(login, (reviewers.get(login) ?? 0) + 1);
  }
  // A review on a commit the PR no longer has (force-pushed away) has no
  // place in the sequence and is not a round; it would otherwise inflate
  // rounds per PR while its findings are already excluded below.
  const rounds = [...new Set(botReviews.map((r) => r.commit_id).filter((sha) => shas.includes(sha)))].sort(
    (a, b) => shas.indexOf(a) - shas.indexOf(b),
  );
  const byRound = new Map<number, number>();
  let late = 0;
  let regress = 0;
  let selfResolved = 0;
  let openAtMerge = 0;
  let unplaced = 0;
  for (const t of threads) {
    const c0 = t.comments.nodes[0];
    const cited = c0?.originalCommit?.oid ?? c0?.commit?.oid ?? "";
    // A thread on a commit the PR no longer has (force-pushed away) has no
    // round and no ancestry; counting it as round one and non-regression
    // would understate both shares, so it leaves the denominator too.
    if (!shas.includes(cited)) {
      unplaced += 1;
      continue;
    }
    // Round of a finding = position of its cited commit among reviewed commits;
    // a cited commit no reviewer submitted on folds into the nearest earlier round.
    let round = rounds.indexOf(cited) + 1;
    if (round === 0) {
      const idx = shas.indexOf(cited);
      round = Math.max(1, rounds.filter((s) => shas.indexOf(s) !== -1 && shas.indexOf(s) <= idx).length);
    }
    byRound.set(round, (byRound.get(round) ?? 0) + 1);
    if (round > 1) late += 1;
    if (shas.indexOf(cited) > 0) regress += 1;
    if (t.isResolved && t.resolvedBy && !isBot(t.resolvedBy.login)) selfResolved += 1;
    // GitHub reports a thread's current state only, not when it was resolved:
    // this is "still unresolved today on a merged PR", a floor for the
    // number open at the moment of merge.
    if (!t.isResolved && pr.mergedAt) openAtMerge += 1;
  }
  if (unplaced > 0) console.error(`PR ${n}: ${unplaced} thread(s) cite commits the PR no longer has; skipped`);
  const placed = threads.length - unplaced;
  // Every thread unplaceable: the PR contributes no finding to any share, so
  // it must not count as a PR with findings or add its rounds to the mean.
  if (placed === 0) continue;
  const rounded = [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([r, c]) => `${r}:${c}`).join(" ");
  console.log(
    `${String(n).padStart(4)} ${String(shas.length).padStart(8)} ${String(rounds.length).padStart(6)} ${String(placed).padStart(7)} ${String(late).padStart(4)} ${String(regress).padStart(7)} ${String(selfResolved).padStart(7)} ${String(openAtMerge).padStart(13)}  ${rounded}`,
  );
  totals.prs += 1;
  totals.rounds += rounds.length;
  totals.threads += placed;
  totals.late += late;
  totals.regress += regress;
  totals.selfResolved += selfResolved;
  totals.openAtMerge += openAtMerge;
}
const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;
console.log(`\nPRs with findings: ${totals.prs}  findings: ${totals.threads}  rounds/PR: ${(totals.rounds / Math.max(1, totals.prs)).toFixed(2)}`);
console.log(`late-round share: ${pct(totals.late, totals.threads)}  cites-later-commit share: ${pct(totals.regress, totals.threads)}  self-resolved: ${pct(totals.selfResolved, totals.threads)}  still unresolved on merged PRs (floor for open at merge): ${totals.openAtMerge}`);
console.log("reviewer submissions:", Object.fromEntries(reviewers));
