# Committed-but-unpushed merge recovery

Epic: [State integrity: strand-proof mutations and single-source identities](epic.md) — complexity **[3]**.

## Objective

A daemon that died between `commitMerge` and `pushDefaultBranch` recovers
on its next start with no human intervention: the vetted-but-unpushed
merge is reset away, and the still-open PR re-gates, re-soaks, and
re-merges through the normal landing tick — per locked
[D1](../../../docs/architecture/decisions/state-integrity.md).

## Hypothesis

### Change

The startup self-heal in `apps/daemon/src/daemon/daemon.run.ts` (beside
`selfHealStagedMerge`, `daemon.run.ts:316`) gains the diverged-branch
case: no `MERGE_HEAD`, local default branch ahead of `origin/<default>`.
It reads the stray head commit and applies the landing-authorship proof —
**all four** must hold:

1. it is a merge commit (two parents);
2. its first parent is the current `origin/<default>` head;
3. its message matches landing's own template
   (`Merge pull request #N from <owner>/<branch>` — the exact format
   `landing.service.ts` writes);
4. its committer identity is the daemon's git identity.

Proven → `git reset --hard origin/<default>` on the primary checkout,
with a loud log line naming the PR number the re-land will pick up.
Any check fails → warn with the observed evidence and leave the checkout
untouched (operator property). Dry-run reports the would-be action and
mutates nothing. `GitService` gains the small observation/reset seams the
check needs (proposed: read a commit's parents/message/committer;
reset-to-remote-head — ownership names, not final symbols).

### Preserved behavior

- `selfHealStagedMerge`'s existing MERGE_HEAD path is unchanged.
- Landing itself is untouched: gates, soak, merge, push all identical —
  recovery never pushes, so landing remains the only push site (D1).
- More than one stray commit, a non-merge stray commit, or a stray commit
  on a non-default branch → untouched, warned.
- Soak counters keep their conservative reset-on-restart stance; the
  re-landed PR pays a fresh soak (accepted in D1).

## Acceptance criteria

- Fixture repo, landing-authored stray merge commit → startup resets to
  origin, logs the PR number, and a subsequent landing pass over the
  still-open PR re-stages cleanly (no `--ff-only` failures anywhere).
- Fixture repo, operator-authored stray commit (non-merge, or wrong
  message, or foreign committer, or first parent ≠ origin head — one test
  per failed check) → checkout untouched, warning names the failed check.
- Origin advanced during the outage (stray commit's first parent is no
  longer origin's head) → untouched, warned — the proof's check 2 makes
  this case operator-reviewed by design.
- Dry-run over the wedge fixture mutates nothing and reports the would-be
  reset.
- Full existing daemon and landing suites unchanged.

## Scope

- `apps/daemon/src/daemon/daemon.run.ts` (+ `daemon.run.test.ts`)
- `packages/core/src/adapters/git.service.ts` (+ test) — observation and
  reset seams only

## Dependencies

None.

## Coordination

Advisory implementation guidance; revalidate against the live checkout.

- Recommended wave: 0
- Parallel candidates: `identity-single-source`, `reconciliation-proofs`
  — disjoint ownership (daemon self-heal + GitService vs identity module
  vs adapter tests).
- Primary ownership: the startup self-heal block in `daemon.run.ts` and
  the new `GitService` seams.
- Shared touchpoints: `git.service.ts` is read (not modified) by
  `reconciliation-proofs`; the new seams are additive.
- Integration handoff: the recovery behavior documented for issue 4's
  `INVARIANTS.md` writer table (the wedge row flips from "unrecoverable"
  to "reset and re-land, D1").
- Isolation assumption: isolated Git worktree; fixture repos in temp
  dirs, never the checkout itself.

## Risk

medium — this code touches the primary checkout at startup; the
authorship proof is the safety mechanism, and each of its four checks
carries its own negative test.

## Decisions

- [D1 — reset and re-land](../../../docs/architecture/decisions/state-integrity.md#d1--a-committed-but-unpushed-landing-merge-is-reset-and-re-landed)

## Context

Death between `commitMerge` and `pushDefaultBranch`
(`landing.service.ts:158-159`) leaves local main diverged from origin
with no `MERGE_HEAD`. Today `selfHealStagedMerge` finds nothing to abort
and cleanup's `--ff-only` pull fails every tick forever — the epic's
merge-wedge diagram, lane two. The deferral note in `daemon.run.ts`
("tracked on issue #4") points at an issue that closed with the fleet
epic; this issue is that tracking, resurrected with a locked policy.
Because origin never received the merge, GitHub still shows the PR open —
which is what makes rewind-and-replay safe: the work is not lost, it is
simply re-landed.

## Approach

Keep the new logic beside `selfHealStagedMerge` in `daemon.run.ts` (same
composition-layer home, same dry-run discipline). The authorship proof is
a pure function over `(commit metadata, origin head, expected message
shape, daemon identity)` — unit-testable without a repo; the fixture-repo
tests then prove the integration. Update the stale "issue #4" comment to
point at D1.

## Runtime trace

```text
runDaemonLoop (managed startup)
└─ self-heal block                                 daemon.run.ts:316 vicinity
   ├─ MERGE_HEAD present → abort path              (existing, unchanged)
   └─ no MERGE_HEAD:
      ├─ local default == origin head → done       (normal case, no-op)
      ├─ ahead of origin:
      │  ├─ landing-authorship proof (4 checks, pure)
      │  │  ├─ all pass → git reset --hard origin/<default>
      │  │  │             log "reset unpushed landing merge; PR #N re-lands"
      │  │  │             ▸ push is NEVER called here (D1)
      │  │  └─ any fail → warn with evidence, leave untouched
      │  └─ dry-run → report, mutate nothing
      └─ behind origin → cleanup's normal auto-pull handles it (unchanged)
```

## Test plan

- Pure proof-function tests: one per check, plus the all-pass case.
- Fixture-repo integration: build a real repo + bare origin in a temp
  dir; stage → commit without push; restart path resets and a landing
  re-stage succeeds. Negative fixtures per failed check; origin-advanced
  fixture; dry-run fixture.
- Regression: `selfHealStagedMerge` existing tests unchanged.

## Required verification

- `bun run check`
- `bun run test`
- `bun run build`

## Out of scope

- Any startup push (rejected in D1).
- Multi-commit divergence recovery — warned, operator-owned.
- Landing-phase changes of any kind.
