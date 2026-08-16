# Issue #82: Stream follow: shared tailers, heartbeat, backpressure, exact resume

> GitHub: https://github.com/egoisutolabs/score/issues/82
> Branch: `issue-82-stream-follow-shared-tailers-heartbeat-b`

---

Epic: Telemetry API: make Score observable without building a UI (#83) —
complexity **[3]**.

## Objective

The stream's live half: after `caught_up`, subscriptions follow appends
through shared per-project tailers with heartbeats, bounded buffers, and
exact `Last-Event-ID` resume — replacing #81's
`FOLLOW_NOT_IMPLEMENTED` seam and completing the epic's outcome.

## Definitions

Ceilings as well as meanings. Reviewers: findings demanding depth beyond a
stated ceiling are out of scope by definition.

- **shared tailer**: one file-tailing loop per project feeds all matching
  subscriptions. `fs.watch` may wake it; correctness comes from byte
  offsets plus a `stat` poll at least every 2 seconds. Ceiling: no
  per-client watchers; no portability layer beyond `fs.watch`-plus-poll.
- **heartbeat**: an SSE comment frame (`:hb`) at least every 15 seconds
  of wall time on an idle stream. Ceiling: constant, not configurable;
  no client liveness detection beyond socket write failure.
- **bounded buffer / slow consumer**: per-subscriber outbound queue of at
  most 1024 envelopes; exceeding it disconnects that subscriber with the
  last fully-written event's cursor intact for resume. Ceiling: constants,
  no adaptive backpressure, no rate shaping.
- **exact resume**: reconnecting with event N's cursor yields event N+1 —
  no gap, no duplicate — independently per selected project/source (a
  quiet project's records are never skipped by a busy one's progress).
  Mid-stream segment deletion (retention during a live stream) → one
  `score.stream.warning`, clean close; the client resumes from an
  explicit time bound.
- **rotation follow**: at UTC date roll the tailer finishes the old
  segment through its final complete line, then continues into the new
  segment; order preserved. Ceiling: no lookback beyond the two segments
  involved.

## Hypothesis

### Change

Extend `apps/web/src/telemetry/` with the tailer registry, subscription
fan-out, heartbeat timer, buffer accounting, and cursor advancement;
remove the `FOLLOW_NOT_IMPLEMENTED` seam.

### Preserved behavior

Replay semantics, snapshots, probes, filter grammar — unchanged. The
route stays read-only; mutating verbs still 405.

## Acceptance criteria

- Live-follow transcript: appends after `caught_up` arrive as envelopes
  with advancing cursors.
- Resume matrix: reconnect at every boundary (mid-batch, at `caught_up`,
  mid-follow); multi-project with one quiet project; telemetry and
  human-log cursors advance independently.
- Rotation-follow fixture: order preserved across the UTC roll.
- Two clients, one tailer (instance-count assertion); 1025th queued
  envelope disconnects with cursor preserved and resumable.
- Idle stream: heartbeat within every 15s window.
- Mid-stream deletion → warning → clean close.

## Scope

- `apps/web/src/telemetry/**`

## Dependencies

- #81 — the seam this replaces and the cursor/filter
  machinery it extends.

## Coordination

- Recommended wave: 4
- Parallel candidates: None — final slice.
- Primary ownership: `apps/web/src/telemetry/**`
- Shared touchpoints: none new.
- Integration handoff: the epic's outcome — resumable SSE observation,
  the evidence base for the successor epic's TUI-removal gate.
- Isolation assumption: shared checkout.

## Risk

medium — tailing and backpressure are the epic's most intricate runtime
behavior, now isolated in a diff that contains nothing else.

## Decisions

- Locked decisions 5, 9, 11 (#83).

## Context

Follow is the piece the first wave never reached. Every constant here
(15s, 1024, 2s, 500) is a named ceiling so review argues about
correctness, not calibration.

## Runtime trace

```text
follow phase (per subscription, after caught_up)
├─ shared tailer emits complete lines → filter → envelope → queue
│   └─ queue > 1024 → disconnect, cursor preserved
├─ :hb ≤ every 15s idle
├─ UTC roll → finish old segment → continue new (order preserved)
└─ segment deleted mid-stream → warning → clean close
```

## Test plan

Two-client concurrency tests; the resume matrix as table tests; rotation
and deletion fixtures over a temp store.

## Required verification

- `bun run check`
- `bun run test`
- `bun run build`

## Out of scope

- New event types or filters, UI, TUI removal, OTLP; anything exceeding a
  stated ceiling.


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
   gh issue comment 82 --body "Found bug: <description of what is wrong and why it is out of scope>"
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
6. Open a PR with `Fixes #82` in the body. Do not add a "Generated with Claude Code" footer or any session URLs.
7. Report the PR URL.
8. Stop after reporting the PR URL.

Do not run blocking PR watcher scripts from inside the implementation session. Review follow-up is handled by the operator or a separate continuation session.

Do not amend unrelated commits. Do not force-push unless explicitly asked.
