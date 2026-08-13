# Invariants doc and review-rule enforcement

Epic: [State integrity: strand-proof mutations and single-source identities](epic.md) — complexity **[1]**.

## Objective

`INVARIANTS.md` exists at the repo root stating the two state-integrity
rules with the audited-writer table behind them, and `AGENTS.md`'s Code
Review Rules name violations of those rules as real defects — so the
review workflow enforces both archetypes on every future PR
automatically.

## Hypothesis

### Change

- New `INVARIANTS.md` (repo root, beside `AGENTS.md`) containing:
  1. **The two rules.** Multi-step external mutations roll back or
     reconcile their own partial state — a death at any step costs at
     most one retried tick. Identities (session names, branch shapes)
     are derived in exactly one place, `dispatch.identity.ts`.
  2. **The audited-writer table** — every multi-step writer, its
     sequence, and its proven next-tick behavior (RETRIED / SELF-HEALED /
     BENIGN-LEFTOVER / RESET-AND-RE-LAND per D1), with test references —
     the epic's Sweep A table upgraded from "believed" to "proven" using
     issues 1–3's outcomes.
  3. The push invariant from D1: nothing pushes to origin except a
     landing tick that just passed its gates.
- `AGENTS.md`: one addition to Code Review Rules — violations of
  `INVARIANTS.md`'s two rules are real defects (a new multi-step writer
  without a rollback/reconcile path; an identity shape derived outside
  `dispatch.identity.ts`).

### Preserved behavior

- Documentation and review-rule change only; zero runtime edits.
- The review workflow needs no change: it already reads the base SHA's
  `AGENTS.md` as its authority.

## Acceptance criteria

- `INVARIANTS.md` exists with the two rules, the completed writer table
  (every row carries its convergence label and test reference), and the
  push invariant.
- `AGENTS.md` Code Review Rules reference `INVARIANTS.md` violations as
  defects.
- Table rows match issues 1–3's landed reality — no "believed" entries
  remain.

## Scope

- `INVARIANTS.md` (new)
- `AGENTS.md` (Code Review Rules addition)

## Dependencies

- `identity-single-source` — the boundary-test reality the identity rule
  documents.
- `unpushed-merge-recovery` — the wedge row's RESET-AND-RE-LAND label.
- `reconciliation-proofs` — the convergence labels for the unproven rows.

## Coordination

Advisory implementation guidance; revalidate against the live checkout.

- Recommended wave: 1
- Parallel candidates: None — convergence artifact; sole writer of both
  files.
- Primary ownership: `INVARIANTS.md`, `AGENTS.md`.
- Shared touchpoints: None at code level.
- Integration handoff: from this PR on, the review workflow enforces the
  archetypes — the epic's outcome condition.
- Isolation assumption: isolated Git worktree.

## Risk

low

## Decisions

- [D1 — reset and re-land](../../../docs/architecture/decisions/state-integrity.md#d1--a-committed-but-unpushed-landing-merge-is-reset-and-re-landed)

## Context

The write-epic toolchain already expects an `INVARIANTS.md` that this
repo never had. Both bug archetypes bit four times before review learned
to catch them — because the review authority (`AGENTS.md`) never named
them. This issue is the epic's convergence: the fixes become rules, the
rules become review policy, and the enforcement is free because the
claude-review workflow reads base `AGENTS.md` on every PR.

## Approach

Keep `INVARIANTS.md` short enough to be read: the two rules stated in
two sentences each, the table, the push invariant, and nothing else.
The `AGENTS.md` addition follows the existing terse rule style
(precedent: the structure/front-door rules added in PR #36).

## Runtime trace

Not applicable — documentation-only slice.

## Test plan

- `bun run check` (markdown untouched by tooling, but the gates prove the
  tree still builds).
- Reviewer-side: the next PR that introduces a multi-step writer without
  rollback gets flagged — observed in practice, not unit-testable.

## Required verification

- `bun run check`
- `bun run test`
- `bun run build`

## Out of scope

- New runtime behavior of any kind.
- Structure/readability rules (already landed in PR #36).
