#!/usr/bin/env bun
/**
 * Exports reviewer findings (root review comments by bot reviewers) for the
 * offline judge:
 *
 *   bun scripts/export-findings.ts egoisutolabs/score --prs 85,86,... >> evals/review-loop/corpus.jsonl
 *   bun scripts/export-findings.ts gendev1/marvelous-monkey --since 2026-08-01 >> evals/review-loop/corpus.jsonl
 *
 * One JSON object per line: id, repo, pr, path, line, commit, author,
 * created_at, hunk (the diff context GitHub attached), body. Needs `gh`.
 * Read-only; writes to stdout.
 */
import { isReviewerBot } from "../packages/core/src/repair/findings/finding.policy";

const [repo, ...rest] = process.argv.slice(2);
if (!repo?.includes("/")) {
  console.error("usage: bun scripts/export-findings.ts owner/repo [--prs a,b,c] [--since YYYY-MM-DD]");
  process.exit(2);
}
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
const isBot = isReviewerBot;

let prs: number[];
const explicit = arg("--prs");
if (explicit) prs = explicit.split(",").map(Number);
else {
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
      prs = list.filter((p) => p.createdAt >= since).map((p) => p.number).sort((a, b) => a - b);
      break;
    }
    limit *= 2;
  }
}

interface Comment {
  id: number;
  path: string;
  original_line: number | null;
  original_commit_id: string;
  in_reply_to_id?: number;
  /** null once the author's account is deleted. */
  user: { login: string } | null;
  created_at: string;
  diff_hunk: string;
  body: string;
}
for (const pr of prs) {
  const pages = JSON.parse(
    await gh(["api", `repos/${repo}/pulls/${pr}/comments`, "--paginate", "--slurp"]),
  ) as Comment[][];
  for (const comment of pages.flat()) {
    // An authorless comment is unknown, not a bot's: skipped, as the baseline and replay do.
    if (comment.in_reply_to_id !== undefined || comment.user === null || !isBot(comment.user.login)) continue;
    console.log(
      JSON.stringify({
        id: `${repo}#${pr}:${comment.id}`,
        repo,
        pr,
        path: comment.path,
        line: comment.original_line,
        commit: comment.original_commit_id,
        author: comment.user.login,
        created_at: comment.created_at,
        hunk: comment.diff_hunk,
        body: comment.body,
      }),
    );
  }
}
