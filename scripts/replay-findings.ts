#!/usr/bin/env bun
/**
 * Replays a merged PR's review threads through the finding ledger's keyer and
 * classifier with live blame, as a check on real data:
 *
 *   bun scripts/replay-findings.ts egoisutolabs/score 99 [checkout=.]
 *
 * Waves are reconstructed from reviewer rounds: a thread's wave is the number
 * of bot review rounds completed before its reviewed commit. Resolution state
 * is GitHub's final state, so "fix-failed" is an upper bound here (live, a
 * self-resolve is only known once it happened) and the per-wave open count
 * is a floor (a thread resolved after the wave reads as resolved during it).
 * Needs `gh` and a checkout holding the PR's commits. Read-only.
 */
import { ExecRunner } from "../packages/core/src/adapters/fixtures/staged-merge.fixture";
import { GitService } from "../packages/core/src/adapters/git.service";
import { isReviewerBot } from "../packages/core/src/repair/findings/finding.policy";
import { FindingTracker } from "../packages/core/src/repair/findings/finding-tracker.service";
import type {
  FindingLedger,
  FindingRecord,
  ReviewThreadObservation,
} from "../packages/core/src/repair/findings/finding.interface";
import { GitHubService } from "../packages/tracker/src/github.service";
import { convergenceVerdict } from "../packages/core/src/repair/convergence/convergence.policy";
import type { WaveRecord } from "../packages/core/src/repair/repair.policy";

const [repo, prArg, checkout = "."] = process.argv.slice(2);
const pr = Number(prArg);
if (!repo?.includes("/") || !Number.isInteger(pr)) {
  console.error("usage: bun scripts/replay-findings.ts owner/repo <pr> [checkout]");
  process.exit(2);
}

const runner = new ExecRunner();
const github = new GitHubService(runner, { repositoryPath: checkout, repository: repo });
const git = new GitService(runner, { repositoryPath: checkout, workspaceRoot: "/nonexistent" });

const gh = (args: string[]) =>
  runner.run(["gh", ...args], { cwd: checkout }).then((r) => {
    if (r.exitCode !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout) as unknown;
  });
const commits = ((await gh(["api", `repos/${repo}/pulls/${pr}/commits`, "--paginate", "--slurp"])) as { sha: string }[][])
  .flat()
  .map((c) => c.sha);
const reviews = ((await gh(["api", `repos/${repo}/pulls/${pr}/reviews`, "--paginate", "--slurp"])) as {
  commit_id: string;
  state: string;
  user: { login: string } | null;
}[][]).flat();
const isBot = isReviewerBot;
// A review on a commit the PR no longer has (force-pushed away) cannot be
// placed in the sequence, so it is not a round; a review whose author GitHub
// no longer names is unknown, not a bot's.
const rounds = [
  ...new Set(
    reviews
      .filter((r) => r.state !== "PENDING" && r.user !== null && isBot(r.user.login))
      .map((r) => r.commit_id)
      .filter((sha) => commits.includes(sha)),
  ),
].sort((a, b) => commits.indexOf(a) - commits.indexOf(b));
const firstHead = rounds[0];
// An author GitHub no longer names (deleted account) is unknown, not a bot.
const threads = [...(await github.observeReviewThreads(pr))]
  .filter((t) => t.author !== undefined && isBot(t.author))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

class ReplayLedger implements FindingLedger {
  records: readonly FindingRecord[] = [];
  waves = 0;
  findings() {
    return this.records;
  }
  firstHead() {
    return firstHead;
  }
  lastWaveHead() {
    return rounds[this.waves - 1];
  }
  waveCount() {
    return this.waves;
  }
  recordFindings(_: number, records: readonly FindingRecord[]) {
    this.records = records;
  }
}
const ledger = new ReplayLedger();
const tracker = new FindingTracker(git, ledger);
const byWave = new Map<number, ReviewThreadObservation[]>();
let unplaced = 0;
for (const t of threads) {
  const idx = commits.indexOf(t.originalCommit ?? "");
  // A thread on a commit the PR no longer has (force-pushed away) cannot be
  // placed in a wave; counting it as wave zero would call it first-round.
  if (idx === -1) {
    unplaced += 1;
    continue;
  }
  const wave = rounds.filter((r) => commits.indexOf(r) < idx).length;
  byWave.set(wave, [...(byWave.get(wave) ?? []), t]);
}
if (unplaced > 0) console.error(`${unplaced} thread(s) cite commits the PR no longer has; skipped`);
// Diff size at each round's head, as repair would have seen it when it pinged.
const base = ((await gh(["pr", "view", String(pr), "-R", repo, "--json", "baseRefOid"])) as { baseRefOid: string })
  .baseRefOid;
const diffSizeAt = async (sha: string) => {
  // Three dots: from the merge base, so a base branch that moved under the
  // PR does not count as the PR's own growth.
  const r = await runner.run(["git", "diff", "--shortstat", `${base}...${sha}`], { cwd: checkout });
  const m = /(\d+) insertions?\(\+\)|(\d+) deletions?\(-\)/g;
  let total = 0;
  for (const hit of r.stdout.matchAll(m)) total += Number(hit[1] ?? hit[2] ?? 0);
  return r.exitCode === 0 ? total : undefined;
};
let seen: ReviewThreadObservation[] = [];
const out = new Map<string, FindingRecord>();
const waves: WaveRecord[] = [];
const verdicts: string[] = [];
const DEFECTS = { conflicting: false, unresolvedThreads: 0, failingChecks: 0 } as never;
// Every round is a wave the ledger would have recorded, including a round
// that opened no inline thread; a thread cited after the last round is wave
// rounds.length, so the walk runs to whichever is later.
const lastWave = Math.max(rounds.length - 1, ...byWave.keys());
for (let wave = 0; wave <= lastWave; wave += 1) {
  ledger.waves = wave;
  seen = [...seen, ...(byWave.get(wave) ?? [])];
  const recs = await tracker.observe(pr, seen);
  for (const r of recs) if (!out.has(r.threadId)) out.set(r.threadId, r);
  // What the gate would have said when repair came to send wave+1.
  const verdict = convergenceVerdict({ waves, findings: recs, budget: 4 });
  verdicts.push(`after round ${wave + 1}: ${verdict ? `${verdict.rule} — ${verdict.detail}` : "continue"}`);
  const head = rounds[wave];
  if (head !== undefined) {
    waves.push({
      at: "",
      tick: wave,
      headSha: head,
      defects: DEFECTS,
      // Distinct reviewer-open keys, as RepairLedger.openFindingCount counts
      // them. The replay sees final resolution state, so on a merged PR this
      // is a floor and findings-flat seldom fires here (see the header).
      openFindings: new Set(recs.filter((r) => r.resolution === "open").map((r) => r.key)).size,
      diffSize: await diffSizeAt(head),
    });
  }
}
const records = [...out.values()];
const tally = (pick: (r: FindingRecord) => string) =>
  records.reduce<Record<string, number>>((m, r) => ({ ...m, [pick(r)]: (m[pick(r)] ?? 0) + 1 }), {});
console.log(`PR ${pr}: ${rounds.length} rounds, ${records.length} findings`);
console.log("classes:", tally((r) => r.class));
console.log("resolutions:", tally((r) => r.resolution));
console.log(`blamed: ${records.filter((r) => r.origin).length}  symbol named: ${records.filter((r) => r.symbol).length}`);
console.log("diff size per round head:", waves.map((w) => w.diffSize).join(" → "));
for (const v of verdicts) console.log(v);
for (const r of records) {
  console.log(`w${r.wave} ${r.class.padEnd(19)} ${r.resolution.padEnd(17)} ${(r.origin ?? "").slice(0, 7).padEnd(7)} ${r.path}:${r.symbol ?? "?"}`);
}
