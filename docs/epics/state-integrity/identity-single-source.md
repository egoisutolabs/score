# Single-source identity derivation

Epic: [State integrity: strand-proof mutations and single-source identities](epic.md) — complexity **[2]**.

## Objective

Every session-name and branch shape in the codebase is derived from
`packages/core/src/dispatch/dispatch.identity.ts`; the three sites that
re-derive shapes as literals consume it instead, with parity pinned by
tests and guarded by a boundary test that fails if a shape literal
reappears.

## Hypothesis

### Change

- `dispatch.identity.ts` gains the derivations the duplicate sites
  hand-roll today (proposed names; the stack names ownership, not final
  symbols): `issueBranchPrefix(issueNumber)` (`` `issue-${n}-` ``),
  `isIssueBranch(name)` (the `/^issue-\d+-/` test), and
  `issueSessionSuffixPattern(namespace)` (the `%N` suffix shapes
  `repair.policy.ts` builds as strings).
- Consumers rewritten to import those functions:
  - `repair.policy.ts:9,18` (`DEFAULT_SESSION_SUFFIX`,
    `sessionSuffixForNamespace`) — derived, preserving the documented
    legacy quirk byte-for-byte (`"^issue-%N"` for unmanaged).
  - `dispatch.service.ts` `#alreadyInFlight` — branch prefix via
    `issueBranchPrefix`.
  - `dispatch.policy.ts:58` (`isOwnedIssueWorktree`) and
    `landing.policy.ts:21` (`onlyIssueBranches` filter) — via
    `isIssueBranch`.
- A boundary test (mirroring the existing `boundary.test.ts` pattern)
  scans `packages/*/src` for `issue-` / `score-…-issue` shape literals
  outside `dispatch.identity.ts` and its tests, and fails on any hit.

### Preserved behavior

- Every derived string equals the literal it replaces, byte for byte —
  parity tests assert the exact current values, including the legacy
  `DEFAULT_SESSION_SUFFIX` quirk documented at `repair.policy.ts:5-9`.
- No runtime flow changes: same matches, same misses, same session and
  branch names everywhere.
- Unmanaged mode untouched.

## Acceptance criteria

- Parity tests: `sessionSuffixForNamespace(undefined)` still returns
  `"^issue-%N"`; `sessionSuffixForNamespace("demo")` still returns
  `"^score-demo-issue-%N"`; `isIssueBranch` accepts/rejects the exact
  strings the old regexes did (including non-numeric and prefix-only
  cases).
- The boundary test fails when a `issue-\d`-shaped literal is introduced
  outside `dispatch.identity.ts` (proven by a fixture in the test
  itself), and passes on the migrated tree.
- Full existing dispatch, repair, landing, and cleanup suites green,
  unchanged.

## Scope

- `packages/core/src/dispatch/dispatch.identity.ts` (+ its test)
- `packages/core/src/repair/repair.policy.ts` (+ test)
- `packages/core/src/dispatch/dispatch.service.ts`
- `packages/core/src/dispatch/dispatch.policy.ts` (+ test)
- `packages/core/src/landing/landing.policy.ts` (+ test)
- boundary test beside the existing `packages/core/src/boundary.test.ts`
  pattern

## Dependencies

None.

## Coordination

Advisory implementation guidance; revalidate against the live checkout.

- Recommended wave: 0
- Parallel candidates: `unpushed-merge-recovery`, `reconciliation-proofs`
  — disjoint primary ownership (identity module vs daemon self-heal vs
  adapter tests).
- Primary ownership: `packages/core/src/dispatch/dispatch.identity.ts`
  and the four consumer sites.
- Shared touchpoints: `dispatch.service.ts` is also touched by
  `reconciliation-proofs` (tests only there). Handoff: whichever lands
  second rebases its tests on the merged tree — no interface conflict.
- Integration handoff: the exported derivation functions; issue 4
  documents them in `INVARIANTS.md`.
- Isolation assumption: isolated Git worktree.

## Risk

low — pure consolidation with byte-parity tests; the boundary test is the
only new behavior.

## Decisions

- [Epic Context — archetype B, identity drift](epic.md#context)

## Context

The PR #31 repair-ledger bug (`shepherd-pr-N` vs
`score-<ns>-shepherd-pr-N`) was archetype B: a name derived in two places
drifting. The epic's Sweep B found the remaining literal sites listed
above. `dispatch.identity.ts` already calls itself the "session-name
authority"; this issue makes that claim true.

## Approach

Add the derivations beside the existing functions with the same
doc-comment style; keep the legacy quirk's comment attached to its new
derivation. The boundary test greps source text (not AST) — one regex,
tolerant of comments via the same allowlist mechanism the existing
boundary test uses.

## Runtime trace

Not applicable — contract-only consolidation; every call site produces
identical strings and match results before and after.

## Test plan

- Byte-parity table tests for every replaced literal (old value written
  as the expected constant in the test, so drift fails loudly).
- Regex-behavior tests for `isIssueBranch` against the exact acceptance
  set of the old `/^issue-\d+-/`.
- Boundary test with a deliberate violation fixture proving it fails,
  and a clean run proving the migrated tree passes.
- Full existing suites unchanged.

## Required verification

- `bun run check`
- `bun run test`
- `bun run build`

## Out of scope

- Triage identity functions (umbrella-triage epic adds its own here).
- Any change to what the shapes are — consolidation only.
