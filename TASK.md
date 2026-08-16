# Issue #93: score up <key> after score down reports all zeros and starts nothing

> GitHub: https://github.com/egoisutolabs/score/issues/93
> Branch: `issue-93-score-up-key-after-score-down-reports-al`

---

## Problem

Twice observed (2026-08-15 and 2026-08-16): after `score down score`, running `score up score` (explicit key) prints `started=0 restarted=0 unchanged=0 removed=0` and does not start the daemon; a bare `score up` immediately afterward starts it (`started=1`). Reproduction is reliable in live use.

## Change

Diagnose the keyed-up path after a down (likely the reconciliation diff treating the explicitly-named, just-removed job as out-of-scope) and make `score up <key>` start a downed project, per INVARIANTS' next-command convergence expectation.

## Acceptance

- Test: down then keyed up converges to a running job.
- Failure-at-each-step evidence per INVARIANTS.md for any touched multi-step sequence.
- `bun run check`, `bun run test`, `bun run build` green.

## Out of scope

Supervisor adapter policy changes.

---

## Repo Context

Read `AGENTS.md` and `CLAUDE.md` at the repository root (and any nested ones
near the code you touch) before writing anything — they are the authority on
this repository's layout, conventions, and invariants. This briefing carries no
repository facts on purpose.

Keep PR scope limited to this issue. Add tests for behavioral changes.

## Workflow

Commit locally at each workflow boundary — after exploration notes, after
implementation, after each review-fix round — with concise messages. Local
commits are the liveness signal the fleet reads; a long quiet stretch with no
commits looks stranded. Push remains end-only, per Completion Instructions.

Work in this order:

1. **Explore before writing.** Map the code this task touches: similar
   patterns, the owning feature folder, its tests. Prefer read-only
   subagents for broad sweeps. If the graphify skill is available, query the
   repository's existing graph first (`graphify-out/` at the root); if the
   graph is missing or stale, index the repository again.
2. **Implement this TASK.md end-to-end.**
3. **Review until clean.** If the codex review skill is available, run it
   over your diff and fix what it finds; repeat until it reports no new
   issues. An unavailable tool skips that tool only — the self-review in
   Completion Instructions is never skipped.
4. **Finish via Completion Instructions** (verification, self-review,
   commit, push, PR).

## Required Verification

Run before committing, at the repository root:

```sh
make verify
```

The repository's Makefile owns what that target does. Never open a PR while
required verification fails: fix it, or — only for a pre-existing, unrelated
failure — document that failure in the PR body and still run the rest.

## Test Integrity

Write tests that would **fail** if the behavior is wrong. If you find yourself
writing a test that passes regardless of the implementation, that is a bug in
the test — fix the test or flag it.

Do not paper over a bug to make tests green. If you discover a defect you
cannot properly fix within this issue's scope:

1. Post a comment on this issue:
   ```sh
   gh issue comment 93 --body "Found bug: <description of what is wrong and why it is out of scope>"
   ```
2. Open the PR anyway with the comment reference in the PR body so the operator
   can see it before merging.
3. Do not silently work around it or write a test that hides it.

## Completion Instructions

1. Implement the issue end-to-end.
2. Run required verification.
3. Self-review the full diff hunk-by-hunk as if it were a stranger's PR,
   against this repository's own review rules (`AGENTS.md` Code Review Rules
   and `INVARIANTS.md` where present). Fix everything you would flag in
   review. If the review changed anything, re-run required verification over
   the fixes before committing.
4. Commit with a concise message. Do not add Co-Authored-By or Claude-Session trailers.
5. Push the branch.
6. Open a PR with `Fixes #93` in the body. Do not add a "Generated with Claude Code" footer or any session URLs.
7. Report the PR URL.
8. Stop after reporting the PR URL.

Do not run blocking PR watcher scripts from inside the implementation session. Review follow-up is handled by the operator or a separate continuation session.

Do not amend unrelated commits. Do not force-push unless explicitly asked.
