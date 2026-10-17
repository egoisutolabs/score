# Review loop baseline

Measured 2026-10-16 from GitHub review threads, before any repair-loop change.
Companion to [review-loop-analysis.md](review-loop-analysis.md). Reproduce
with `bun scripts/review-loop-baseline.ts <owner/repo> --prs ...`; the method
and its limits are in that script's header.

## Numbers

Score (`egoisutolabs/score`, the 14 PRs of 2026-08-15 to 2026-09-05 that
carry reviewer threads: 71, 85, 86, 89, 90, 94, 95, 97, 99, 101, 102, 104,
107, 111):

| Metric | Value |
| --- | --- |
| Findings (reviewer-opened threads) | 138 |
| Rounds per PR | 3.57 |
| Findings opened in round 2 or later | 59% |
| Findings citing a commit after the first | 75% |
| Threads resolved by the human login (agent or human) | 80% |
| Threads resolved by a reviewer bot | 1 |
| Findings on merged PRs still unresolved at measurement time (a floor for "open at merge": GitHub keeps no resolution timestamp) | 26 |

Limen (`gendev1/marvelous-monkey`, 61 PRs with reviewer threads):

| Metric | Value |
| --- | --- |
| Findings | 173 |
| Rounds per PR | 1.72 |
| Findings opened in round 2 or later | 32% |
| Findings on merged PRs still unresolved at measurement time | 55 |

Both repos together: 311 findings over 75 PRs. The analysis cites 377
findings over 25 PRs; that count could not be reproduced from the threads
and the difference does not change the diagnosis.

## PR 99 as the named case

Issue 93 asked for one wait on the launchd bootout drain. The timeline:

- 05:21 first commit; Codex reviews it at 05:27 with 4 findings.
- Eight fix commits follow, each 2 to 6 minutes after the previous Codex
  review and each titled "Address PR #99 round-N review".
- Codex posts a review 4 to 9 minutes after every commit; the Claude
  reviewer posts on rounds 1 and 6 only.
- 06:23 last commit; 06:32 merged. Codex's last review is on the commit
  before, so the head commit merged unreviewed.
- Result: 19 findings, 8 rounds, 394 added lines, every thread resolved by
  the human login, zero by a reviewer.

The analysis says a human closed PR 99. It merged. The non-convergence it
describes is otherwise as stated.

## What the evidence does not support

- "Wait for a Codex review on the head commit." Of the 13 PRs with zero
  findings, none received a Codex review submission; Codex posts only when
  it has findings. A head-commit wait on Codex can only be a settle timeout.
  The landing change in Phase 1 step 4 must be designed as one.
- The agent's self-resolve is not separable from the human's in GitHub data:
  the agent acts on the human's `gh` token. The ledger must record resolves
  it performs itself to tell them apart.

## Phase 1 step 1: repair prompt as a wave

Evidence: the numbers above, the old prompt in `git show HEAD~1:packages/
core/src/repair/repair.policy.ts` ("address any unresolved review threads
... fix each in code, then resolve"), and the PR 99 timeline.

Decision: `renderRepairPrompt` now issues the seven-step wave from analysis
§2.1 as a single line. New-code findings are FIX or DECLINE, never a triage
issue. A DECLINE is never resolved by the agent. FIX threads are still
resolved by the agent after the commit, because landing's precondition
counts unresolved threads and Codex never resolves its own; that coupling is
removed by the ledger (step 3), not here.

Rejected: a multi-line prompt (tmux ping submits on the first newline); a
prompt file for ping (changes the agent-runtime port, out of this step's
scope); moving the prompt into the prompts folder now (step 6, one change at
a time).

External check: contract tests in `repair.policy.test.ts` assert step order,
single line, decline path, no-triage rule, test-before-fix, verify before
push, and merge refusal. The online check is the table above, re-measured
after the next batch of PRs: rounds per PR, late-round share, and findings
open at merge, segmented by prompt version once step 6 records it.

## Phase 1 step 2: repair gate and round budget

Evidence: the PR 99 timeline above. Every one of its eight fix commits landed
2 to 6 minutes after the previous Codex review, while the Claude check on
the new head was still running; the repair ledger re-pinged the live session
as soon as the thread count changed. Across the score set, 9 of 14 PRs with
findings finished within four rounds. The five that went past four (85, 86,
94, 99, 102) produced 64 of the 81 late-round findings, and the 25 findings
opened after round four were all regressions from earlier fixes.

Decision: repair now reports `CHECKS_PENDING` and sends nothing while any
check on the head commit is running. Each PR has a round budget
(`REPAIR_ROUND_BUDGET`, default 4) counted in pings and spawns since the PR
was last clean. On exhaustion repair posts one comment carrying the wave
history under a hidden marker, adds the `repair-exhausted` label, and stops.
The label outlives the in-memory ledger, so a restart keeps the PR parked;
removing the label is how a human grants a fresh budget. The daemon never
closes the PR.

Rejected: a timer instead of a check gate (Codex posts no check, so the
timer would have to guess its latency); counting rounds in GitHub review
submissions (Codex reviews only when it has findings, so a clean round is
invisible); persisting the budget now (step 3 persists the whole ledger, and
the label already makes the parked state restart-safe).

External check: `repair.service.test.ts` proves the gate, the exhaustion
sequence, both death boundaries, and the labeled no-op; `repair-ledger.
service.test.ts` proves the count, the wait, the reset on clean, and the
fresh budget on label removal. Online: rounds per PR must not exceed the
budget in the next batch, and the number of PRs that hit the label is the
new figure to watch.

## Phase 1 step 3: the finding ledger

Evidence: the baseline cannot tell a new defect from a re-raised one, because
GitHub threads carry a path and a line, and the line moves with every fix. In
PR 99, 80% of resolves were by the human login, that is the agent on the
operator's token, and no reviewer closed anything.

Decision: every review thread repair observes is keyed by blame origin
commit, file, and enclosing symbol, taken at the commit the reviewer wrote
against so the key never moves. A finding is classified on first sight
against the PR's recorded history (analysis §2.4): `first-round` before any
wave, then `fix-failed` (same key as a thread the agent resolved itself),
`duplicate` (same key open from the other reviewer), `regression-from-fix`
(blame places the line after the first wave's head), else `missed-earlier`.
A thread resolved by anyone but a reviewer bot is recorded as
`self-resolved` and still counts as open in the ledger's own count. The
ledger (waves, budget state, first head, findings) is persisted per project
at `~/.score/projects/<key>/repair-ledger.json`, written whole via tmp and
rename, and restored at daemon start with the pacing tick clamped so a
restart neither re-pings early nor waits out the old tick gap.

Blame runs once per thread, the first time it is seen; later passes only
refresh resolution. Blame or show failures degrade the key to the reviewed
commit and line and never fail the pass. The landing gate still uses GitHub's
unresolved count; moving it to the ledger's count is step 4's decision, not
this one's.

Rejected: keying by path and line (moves every fix); keying by comment text
similarity (a classifier question, kept for the port in step 5); a second
GraphQL query per PR (the full threads replace the bare count for repair,
one query); a database (one JSON file per project, same pattern as
status.json).

External check, offline: `bun scripts/replay-findings.ts egoisutolabs/score 99`
replays PR 99's real threads through the tracker with live blame on this
checkout.

| PR 99 replay | Value |
| --- | --- |
| Threads blamed to an origin commit | 19 of 19 |
| Threads with an enclosing symbol | 17 of 19 |
| Round-one findings | 5 |
| Later findings classed fix-failed or regression-from-fix | 11 of 14 |
| Later findings classed missed-earlier | 3 |

The replay uses GitHub's final resolution state, so fix-failed is an upper
bound; live, the ledger learns a self-resolve only when it happens. Every
later finding in `withProjectLock` and `runDown` keyed to the same symbol
the previous fix touched, which is the analysis' "patches the example"
pattern made countable. Online: the class mix per wave, segmented by prompt
version once step 6 records it.

## Phase 1 step 4: landing settle wait

Evidence: Codex posted no review on any of the 13 PRs with zero findings, so
a "Codex reviewed this head" signal does not exist for a PR that is clean
enough to merge. Of the 38 merged PRs with any Codex activity, 22 merged with
the head commit never reviewed by Codex. Codex latency from commit to review
across 85 reviews:

| Percentile | Minutes |
| --- | --- |
| p50 | 6.8 |
| p75 | 8.9 |
| p90 | 11.3 |
| p95 | 12.0 |
| p99 | 25.6 |

The Claude reviewer runs as a check, so `checks-pending` already covers it
(p50 8.1 min, max 26 min).

Decision: landing records when it first sees each PR's head, in any state,
and refuses to stage a clean PR until `REVIEW_SETTLE_MS` (default 15 min)
has passed since then. The clock starts at the push, not at the first green
tick, so a PR whose checks took longer than the window pays nothing extra. A
new head restarts it. The plan's "or a Codex review on the head commit"
branch is dropped: with Codex silent on clean runs it could never fire for a
mergeable PR, and a mechanism that cannot fire is one more thing to be wrong.
Landing's unresolved count stays GitHub's; the ledger's self-resolved state
feeds the convergence rules, not this gate, because Codex never resolves its
own threads and a ledger-count gate would park every PR it ever commented on.

Rejected: commit time from git as the clock start (an agent commits minutes
before it pushes, which would shorten the wait); a per-PR GitHub reviews
query to detect a Codex round on the head (never true for a clean head);
persisting the clock (a restart only lengthens the wait).

External check: `landing.service.test.ts` proves the wait, the restart on a
new head, the clock starting under pending checks, and the forget-on-leave.
Online: the share of merged PRs whose head commit Codex never reviewed, from
the baseline's 22 of 38, must fall to the latency tail past 15 minutes.

## Phase 1 step 5: convergence gate

Evidence: the PR 99 replay, with diff size per round head measured by
`git diff --shortstat` against the PR base:

| Round | Diff lines | Open findings after the round |
| --- | --- | --- |
| 1 | 1707 | 5 |
| 2 | 1637 | 9 |
| 3 | 1698 | 11 |
| 4 | 1722 | 13 |
| 5 | 1731 | 14 |
| 6 | 1745 | 17 |
| 7 | 1792 | 18 |
| 8 | 1062 | 19 |

Open findings never fell. The diff grew every round from round two until
the final squash. Two of the four round-two findings blamed to the round-one
fix commit, both in `runDown`.

Decision: the park path from step 2 is now driven by four deterministic
rules, checked in order, with the first to fire named in the exhaustion
comment: the round budget; open findings that do not decrease across the
last three waves; a diff that grows across the last three waves; a finding
blame places after the head the last wave was sent to fix. Each wave record
carries the open-finding count and the PR diff size as repair saw them when
it pinged. A classifier (jev or another) sits behind a port that answers one
probability per finding; the default answers nothing, and the only effect an
answer has today is that a finding judged under one half real does not count
toward the regression rule.

Rule 3 fires on a single finding after the first answered wave, as the
analysis lists it. The cost is a human look at a PR whose first fix drew one
follow-up; the replay shows that this is also the earliest point at which
PR 99 could have been stopped.

Rejected: a model orchestrator (analysis §2.3, the mandate caused the
rounds, not the lack of context); rule 3 requiring two consecutive
regressions (softer, but not what the plan specifies, and PR 99 would have
run one round longer); counting GitHub reviews as rounds (invisible when
Codex is silent).

External check: `convergence.policy.test.ts` proves each rule, its
threshold, and its silence on a converging loop; `repair-ledger.service.
test.ts` proves a rule parks before the budget. The replay of PR 99:

| After round | Verdict |
| --- | --- |
| 1 | continue |
| 2 | regression-from-fix (2 findings blame to the last fix, `runDown`) |
| 3 | continue |
| 4 | findings-flat (5 → 9 → 11) |
| 5 and later | budget (4) |

Live, the PR would have parked after round two with 9 findings and 1637
changed lines, against the 19 findings and 8 rounds it ran to. Online: the
share of parked PRs by rule, and whether a human un-parks them (label
removed) or finishes by hand.

## Phase 1 step 6: prompts folder

Evidence: Score put text in front of a model from five places in four
feature folders (the briefing in dispatch, the implementation line inline in
the dispatch service, the repair wave in repair policy, two stranded prompts
in cleanup policy), plus the reviewer prompt in the workflow YAML and the
Code Review Rules in AGENTS.md. None carried a version, so no metric could
be segmented by what the agent was told.

Decision: `packages/core/src/prompts/` holds one render module per prompt,
TypeScript templates, each exporting a content-hash version taken over a
canonical render. The four Score prompts moved there; their old names stay
as re-exports so deep imports and tests keep working. The reviewer prompt
and the review rules are copies, each pinned to its source file by a test
that fails on drift, because GitHub reads the YAML and both reviewers read
AGENTS.md from the checkout. The briefing and implementation versions ride
every `score.dispatch.decision` started record; the repair version rides
every PINGED or SPAWNED repair record and every wave in the ledger.

Rejected: text files for templates (vitest cannot import them, and the
prompts interpolate); moving the reviewer prompt out of the YAML into a file
the workflow reads (the review must follow the base SHA's rules, which the
inline prompt already enforces by `git show BASE:AGENTS.md`; a file read
would add a second place for a PR to tamper with); hand-bumped version
numbers (an edit without a bump is exactly the drift this prevents).

External check: `prompts.test.ts` proves the versions are distinct and
stable, the reviewer copy equals the workflow block, the rules copy equals
the AGENTS.md section, and the implementation line's shape. Online: rounds
per PR, late-round share, and findings open at merge, grouped by
`repair_prompt_version` and `briefing_version` from telemetry.

## Phase 1 step 7: evals, tiers 1 and 3

Tier 1, contract tests, now covers every prompt: the briefing (twelve tests
in `task-briefing.service.test.ts`), the repair wave (`repair.policy.test.ts`),
the implementation line and the two stranded prompts (`prompts.test.ts`), and
the two copies pinned to their sources (reviewer workflow, AGENTS.md rules).

Tier 3, online metrics, needed records the loop did not emit. The daemon
now writes, on the PR subject and the phase trace:

| Record | When | Carries |
| --- | --- | --- |
| `score.repair.wave` | each ping or spawn | wave index, open findings, diff size, head, prompt version, defects |
| `score.repair.finding` | a thread's first keying | key, class, wave, from-last-fix, resolution, path, symbol, author |
| `score.repair.parked` | the pass that parks a PR | rule as attribute, the numbers in the body |
| `score.repair.open_at_merge` | a landing merge | ledger-open and total findings for that PR |

`reviewLoopMetrics` (apps/server/src/telemetry/metrics) folds those into the
baseline table per repair prompt version: PRs, waves per PR, late-round
share, late-round regression share, merged PRs, findings open at merge, and
parks by rule, plus dispatches per briefing version.
`bun scripts/review-loop-metrics.ts <project-key>` prints it from a project's
telemetry segments. A PR is attributed to the prompt version of its last
wave, so a prompt change mid-PR counts under the version that finished it.

Decision on the metric definitions: "late-round regression share" is the
share of findings first seen after wave one whose class is fix-failed or
regression-from-fix; "open at merge" uses the ledger's count, which keeps the
agent's own resolves open. Both are the figures the baseline measured by
hand, now from the loop's own records.

External check: `review-loop.metrics.test.ts` proves the segmentation, the
"none" bucket for a PR with no wave, and the empty case;
`telemetry.render.test.ts` proves each record passes the telemetry policy.
The first live numbers come from the next batch of PRs under this branch.

Tier 2, the offline judge over the labeled findings, is the next change.

## Phase 1 step 7: evals, tier 2

The offline judge lives in `evals/review-loop/` with two scripts:
`scripts/export-findings.ts` writes reviewer root comments (path, line,
commit, author, the diff hunk GitHub attached, the text) as a JSONL corpus;
`scripts/review-loop-judge.ts` grades each item with the Claude CLI in JSON
mode against `rubric.md` and the live briefing's Defect Prevention and Test
Integrity sections, caches verdicts per item, rubric, briefing, and model,
and reports the prevention rate, the class mix, the false-positive rate on
`known-negatives.jsonl`, and judge-human agreement (percent and Cohen's
kappa) on `calibration.jsonl`.

The corpus holds 253 findings from both repos. First run, 25 findings from
PRs 71 and 85 plus the ten known negatives:

| Figure | Haiku 5.5 | Sonnet 5.5 |
| --- | --- | --- |
| Known negatives judged real | 0 of 10 | 0 of 10 |
| Corpus judged real | — | 23 of 25 |
| Judged prevented by the briefing | — | 22 of 25 |
| Class mix | — | validation 17, numeric-logic 3, other 3, boundaries 1, test-integrity 1 |

Read the prevention rate as untrustworthy until the calibration set is
labeled: the rubric marks a finding prevented whenever it is real, in a
named class, and in changed code, and a judge that is also the implementer's
model will say yes to that readily. Two signs the rubric is too loose: 22
of 25 prevented, and 17 of 25 in one class. The twenty-item calibration
template is seeded with null labels; the run reports agreement per field
once they are filled, and the rubric says a kappa under 0.6 on `prevented`
means fix the rubric before reading the rate. That labeling is the one step
in Phase 1 only a human can do.

Repair-plan quality on real waves is not judged yet: it needs the new
prompt's own waves as input, and none exist before the branch runs live. The
wave telemetry from tier 3 is what will feed it.

Rejected: grading the repair prompt's text against each wave without an
agent output (it would grade the template, which the contract tests already
pin); an open-ended judge prompt (the three typed fields are what the
calibration can check).

External check: the harness ran end to end against the CLI with cached,
reproducible verdicts; the known-negative rate is 0 of 10 on both models.
The number that matters, judge-human agreement, is waiting on labels.
