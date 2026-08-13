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

**Decision:** When startup self-heal finds no `MERGE_HEAD` but the local
default branch ahead of `origin`, and the stray commit is provably
landing-authored (merge commit; first parent is origin's current head;
message matches landing's own template; committed by the daemon's
identity), it resets the local default branch to `origin`. The pull
request — still open, because origin never saw the merge — re-gates,
re-soaks, and re-merges on the normal landing tick. Anything not provably
landing-authored is operator property: warn and leave untouched. Dry-run
reports and mutates nothing.

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

- `selfHealStagedMerge` (or a sibling) in `apps/daemon/src/daemon/daemon.run.ts`
  gains the diverged-default-branch branch; landing itself is untouched.
- Fixture-repo tests must cover: landing-authored commit → reset and
  successful re-land; operator commit → untouched with a warning; origin
  advanced during the outage; dry-run inertness.
- The soak counters reset with the daemon (existing conservative-reset
  stance), so the re-landed PR pays a fresh soak — accepted cost.

**Evidence:**

- `packages/core/src/landing/landing.service.ts:158-159` (commit → push
  adjacency, the death window).
- `apps/daemon/src/daemon/daemon.run.ts:301` (existing staged-merge
  self-heal this decision extends).
- Live probe in the epic's Current state table: the wedge presents as
  `--ff-only` pull failures every tick with no `MERGE_HEAD` to abort.
