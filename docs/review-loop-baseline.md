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
