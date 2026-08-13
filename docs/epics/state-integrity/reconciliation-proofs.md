# Next-tick reconciliation proofs

Epic: [State integrity: strand-proof mutations and single-source identities](epic.md) — complexity **[3]**.

## Objective

Every multi-step external writer the epic's Sweep A marks **unproven** has
a test per step boundary proving what the next tick sees after a death
there — retried, self-healed, or an explicitly-asserted benign leftover —
and anything the tests expose as a real strand is fixed in the same PR.

## Hypothesis

### Change

Tests (and only where a test exposes a strand, fixes) for the three
unproven writer sequences:

1. **`OpencodeService.startRepair`** (abort → delete → create → prompt,
   `opencode.service.ts:89-119`): fail each of the four calls via the
   fake server's path-targeted `failNext`; assert the next repair pass
   converges — a dead old session is re-resolvable or gone, a
   created-but-unprompted repair session is reclaimed or re-briefed by
   the kill-first re-entry, and one brief is ultimately delivered.
2. **`TmuxService.startRepair`** (write prompt file → kill-session →
   new-session, `tmux.service.ts:95-121`): fail the new-session spawn;
   assert the next pass's kill-first re-entry recovers, and the leftover
   prompt file is overwritten, not duplicated.
3. **`CleanupService` remove → deleteBranch** (`cleanup.service.ts:59-61`):
   fail `deleteBranch` after a successful `removeWorktree`; assert the
   leftover branch is benign — the next dispatch of a same-numbered issue
   reuses it via `createWorktree`'s branch-exists path
   (`git.service.ts:70-75`), and cleanup does not loop on it.

### Preserved behavior

- No production code changes unless a test exposes a real strand; any fix
  follows the established pattern (each writer reclaims its own partial
  state, best-effort, original error surfaced) from PR #31.
- Phase order, authority, pacing untouched.
- Dry-run behavior untouched and asserted along the way.

## Acceptance criteria

- One test per step boundary per sequence above (the epic's validation
  strategy: "kill every remaining multi-step writer at each step
  boundary").
- Each test's assertion names the convergence mode: RETRIED, SELF-HEALED,
  or BENIGN-LEFTOVER (asserted, not assumed) — these labels feed issue
  4's writer table directly.
- Any exposed strand is fixed in this PR with the rollback pattern, and
  the test flips from documenting the strand to pinning the fix.
- Full existing suites green.

## Scope

- `packages/agents/src/opencode.service.test.ts`
- `packages/agents/src/tmux.service.test.ts`
- `packages/core/src/cleanup/cleanup.service.test.ts`
- Production files only if a strand is exposed (same files' non-test
  siblings).

## Dependencies

None.

## Coordination

Advisory implementation guidance; revalidate against the live checkout.

- Recommended wave: 0
- Parallel candidates: `identity-single-source`,
  `unpushed-merge-recovery` — test-side ownership here is disjoint from
  the identity module and the daemon self-heal.
- Primary ownership: the three test suites above.
- Shared touchpoints: `dispatch.service.ts` tests (issue 1 touches the
  service) — handoff: whichever lands second rebases; `git.service.ts`
  is read-only here while issue 2 adds seams — additive, no conflict.
- Integration handoff: the per-writer convergence labels for issue 4's
  `INVARIANTS.md` audited-writer table.
- Isolation assumption: isolated Git worktree.

## Risk

low-medium — mostly tests; the risk is discovering a real strand, which
is the point.

## Decisions

- [Epic Context — archetype A, stranded partial state](epic.md#context)

## Context

The epic's Sweep A table claims these three sequences are self-healing or
benign — by code reading, not by test. The same table's claims were true
for dispatch and `startImplementation` only after PR #31 *made* them
true. "Self-healing by kill-first parity" is folklore until a test kills
the sequence at each boundary and watches the next tick; this issue
converts folklore into pinned behavior, which is what lets `INVARIANTS.md`
call the table audited rather than believed.

## Approach

Reuse the established seams: the opencode fake server's path-targeted
`failNext(status, pathIncludes)`, `ScriptRunner`-style command fakes for
tmux, and the cleanup suite's `FakeWorkspace`. Name each test after its
boundary ("startRepair: child dies between create and prompt") so the
suite reads as the audit table.

## Runtime trace

Representative (opencode startRepair, death after create):

```text
repair pass N:   abort ✓ → delete ✓ → create ✓ → prompt ✗ (server 500)
                 ▸ phase records the failure; no ledger entry (SPAWNED not reached)
repair pass N+1: shouldAct → true (no entry) → startRepair re-entry
                 └─ resolveExact finds the unprompted session
                    → abort ✓ → delete ✓ → create ✓ → prompt ✓   RETRIED
                    ▸ exactly one live briefed session; no duplicates
```

## Test plan

The acceptance criteria are the test plan: boundary-per-sequence tests
with named convergence modes, dry-run assertions preserved, and
regression suites green.

## Required verification

- `bun run check`
- `bun run test`
- `bun run build`

## Out of scope

- The landing merge wedge (issue 2 owns it).
- New rollback machinery beyond the established per-writer pattern.
- Supervisor `up` partial-install auditing (no evidence of a strand;
  revisit only if one appears).
