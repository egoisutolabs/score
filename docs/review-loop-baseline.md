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
| Findings still open when the PR merged | 26 |

Limen (`gendev1/marvelous-monkey`, 61 PRs with reviewer threads):

| Metric | Value |
| --- | --- |
| Findings | 173 |
| Rounds per PR | 1.72 |
| Findings opened in round 2 or later | 32% |
| Findings still open when the PR merged | 55 |

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
