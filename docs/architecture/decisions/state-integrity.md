# Decisions — State integrity: strand-proof mutations and single-source identities

These decisions are locked. Changes must explicitly supersede them.

## Context

The opencode-runtime epic surfaced two recurring bug archetypes: stranded
partial state (a multi-step writer dies mid-sequence and the leftover reads
as in-flight forever) and identity drift (the same name derived in two
places, disagreeing). The one known archetype-A instance with no recovery
is the committed-but-unpushed landing merge, whose tracking issue (#4)
closed with the fleet epic. Recovery policy had to be locked before child
issues could be written.

Umbrella: TODO(graduate-epic)

## D1 — A committed-but-unpushed landing merge is reset and re-landed

*Amended 2026-08-13 after PR #39 review (five findings incorporated; the
policy survived, its predicate, trigger, and preconditions changed).*

**Decision:** Reconciliation runs **every pass** (startup is merely the
first): whenever the local default branch is ahead of `origin` with no
`MERGE_HEAD`, and the working tree is **clean**, and the stray commit is
provably landing-authored, the local default branch is reset to `origin`.
The pull request — still open, because origin never saw the merge —
re-gates, re-soaks, and re-merges on the normal landing tick.

The landing-authorship proof:

1. it is a merge commit (two parents);
2. its first parent is an **ancestor of (or equal to)** the current
   `origin/<default>` head — so origin advancing during the outage does
   not strand the recovery;
3. its message matches landing's own template
   (`Merge pull request #N from <owner>/<branch>`);
4. for commits made after this epic lands: its committer is the distinct
   identity landing now stamps on merge commits (`commitMerge` gains a
   metadata-only committer stamp so this check is provable; older strays
   rely on checks 1–3).

Preconditions and refusals: a **dirty working tree refuses recovery
loudly** (`reset --hard` must never eat operator edits); anything not
provably landing-authored is operator property — warn and leave
untouched; dry-run reports and mutates nothing.

**Failure presentation** (corrected by review): immediately after the
crash, local `main` is a *descendant* of origin — `--ff-only` pulls
no-op ("Already up to date") and the system sits in silent limbo with
the PR never closing. True divergence (and `--ff-only` failures) appear
only once origin advances. Per-tick reconciliation covers both — and
also covers the no-crash variant where `pushDefaultBranch` merely threw
(phase errors are caught and the daemon lives, so startup-only recovery
would never fire).

**Rationale:**

- Landing's tick remains the only code path that ever pushes to origin —
  recovery never becomes a second merge authority, and the audit sentence
  "nothing pushes except a landing tick that just passed its gates" stays
  footnote-free.
- The re-land re-observes the world by construction: a review thread or
  `hold` label that appeared during the outage is honored. A startup push
  would publish a pre-crash decision without looking.
- Wrong guesses stay local and reversible (reflog + still-open PR). A
  wrong startup push publishes to origin, and undoing that means
  force-pushing the default branch — the one operation nothing in this
  system is permitted to do.

**Rejected alternatives:**

- **Push the vetted merge at startup** — saves ~10–40 minutes of machine
  time nobody is waiting on; costs a second push site, a staleness window,
  and a non-fast-forward fallback path that ends up needing reset-and-
  re-land anyway.
- **Fail loudly and wait for the operator** — institutionalizes the
  operator-lockout state the epic exists to eliminate.

**Impact:**

- A reconciliation helper beside `selfHealStagedMerge` in
  `apps/daemon/src/daemon/daemon.run.ts`, invoked at startup **and once
  per pass** (cheap: one local-vs-origin head comparison when nothing is
  stranded).
- `GitService.commitMerge` gains a metadata-only committer stamp (the
  one deliberate touch to landing — it changes no gate, no message, no
  flow).
- Fixture-repo tests must cover: landing-authored commit → reset and
  successful re-land; the same **with origin advanced** (check 2's
  ancestor form); operator commit → untouched with a warning; **dirty
  working tree → loud refusal, no reset**; push-failed-daemon-alive →
  reconciled on a later pass without restart; dry-run inertness.
- The soak counters reset with the daemon (existing conservative-reset
  stance), so the re-landed PR pays a fresh soak — accepted cost.

**Evidence:**

- `packages/core/src/landing/landing.service.ts:158-159` (commit → push
  adjacency, the death window).
- `apps/daemon/src/daemon/daemon.run.ts:316` (existing staged-merge
  self-heal this decision extends).
- Live probe in the epic's Current state table: the wedge presents as
  `--ff-only` pull failures every tick with no `MERGE_HEAD` to abort.
