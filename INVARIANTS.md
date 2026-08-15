# Invariants

Two state-integrity rules, the audited writers behind the first, and the
push invariant. Violations are review defects (see `AGENTS.md`, Code
Review Rules). Recovery policy is locked in
[D1](docs/architecture/decisions/state-integrity.md#d1--a-committed-but-unpushed-landing-merge-is-reset-and-re-landed).

## Rule 1 — Multi-step external mutations converge

Every writer that mutates external state in more than one step (worktrees,
sessions, branches, origin) rolls back or reconciles its own partial state.
A process death at any step boundary costs at most one retried tick — never
a permanently stuck issue, a torn-down live agent, or a wedged checkout.

## Rule 2 — Identities have one source

Session names and branch shapes are derived in exactly one place:
`packages/core/src/dispatch/dispatch.identity.ts`. No other module spells
an `issue-N` / `score-<ns>-issue-N` shape as a literal — enforced by
`packages/core/src/dispatch/boundary.test.ts`, which fails the build if a
shape literal reappears outside the authority module.

## Audited writers

Every multi-step external writer, its sequence, and its proven next-tick
behavior. Proof = the test(s) that kill the sequence at each step boundary
and assert convergence.

| Writer sequence | Site | Next tick | Proof |
| --- | --- | --- | --- |
| createWorktree → briefing → startImplementation | `dispatch.service.ts` `startIssue` | RETRIED — worktree rolled back on a mid-start failure | `dispatch.service.test.ts` "a mid-start failure rolls back the created worktree so the next tick retries (#32)" |
| create session → prompt_async | `opencode.service.ts` `startImplementation` | RETRIED — the unprompted session is aborted and deleted | `opencode.service.test.ts` "startImplementation reclaims the created session when the initial prompt fails (#32)" |
| abort → delete → create → prompt | `opencode.service.ts` `startRepair` | RETRIED — kill-first re-entry converges from a death at any of the four steps | `opencode.service.test.ts`, the four "startRepair: child dies at …" boundary tests |
| write prompt file → kill-session → new-session | `tmux.service.ts` `startRepair` | SELF-HEALED / RETRIED — prompt overwritten, kill-first tolerates a missing session | `tmux.service.test.ts` "startRepair: kill-session finds nothing … (SELF-HEALED)" and "startRepair: child dies at new-session … (RETRIED)" |
| stageMerge → gates/soak → commitMerge → pushDefaultBranch | `landing.service.ts` `runTick` | RESET-AND-RE-LAND (D1) — per-pass reconciliation resets a provably landing-authored unpushed merge to origin; the still-open PR re-gates and re-lands | `daemon.run.test.ts` reconcile suite ("reconcile resets a landing-authored unpushed merge and the PR re-stages cleanly" and its refusal/dry-run/no-restart siblings) |
| removeWorktree → deleteBranch | `cleanup.service.ts` | BENIGN-LEFTOVER — a surviving branch is reported NOT_FOUND next pass, no retry loop | `cleanup.service.test.ts` "cleanup: deleteBranch fails after removeWorktree — next pass reports NOT_FOUND, no retry loop (BENIGN-LEFTOVER)" |
| stop → confirm session absent → removeWorktree → deleteBranch (stranded reclaim, #64) | `cleanup.service.ts` `#reclaimStranded` | RETRIED / BENIGN-LEFTOVER — a death after stop re-enters through the session-missing path; a session surviving stop defers the reclaim loudly; a death after removeWorktree leaves the same benign branch redispatch reattaches to | `cleanup.service.test.ts` "death after stop, before removeWorktree — next tick re-reclaims (RETRIED)", "death after removeWorktree, before deleteBranch — leftover branch is benign, no retry loop (BENIGN-LEFTOVER)", and "a session that survives stop blocks the reclaim" |
| stop → startImplementation (stranded respawn over preserved dirt, #64) | `cleanup.service.ts` `#preserveDirtyWorktree` | RETRIED — a death before the respawn completes re-enters the same session-missing + dirty arm next tick and retries it; the worktree is never removed on this path | `cleanup.service.test.ts` "death before the respawn completes — next tick respawns (RETRIED)" |
| read definition → stop → install → record → start | `supervisor.run.ts` `runRestart` | RETRIED / SELF-HEALED — read-before-stop refuses to boot out a job with no restorable definition; a death after stop leaves a definition-only job the next `score up` re-installs and starts; a death after install leaves a registered job the supervisor launches itself (launchd KeepAlive implies RunAtLoad, systemd installs with `enable --now`) and a retried restart converges; concurrent mutations on one project (`up` vs `restart`) are serialized by a per-project lockfile — the contended command fails without mutating, and a lock whose holder is dead is broken, so a death while holding it costs one retried command | `supervisor.run.test.ts` "restart with no saved definition …", "restart step failure at stop …", "restart death after stop …", "restart death after install …", "restart racing a config-changing up …", "a live holder's lock blocks …", "a stale lock (dead holder or garbage) is broken …" |

## Push invariant

Nothing pushes to origin except a landing tick that just passed its gates.
Recovery (D1) never pushes — it resets local state and lets the normal
landing tick re-land. There is no second push site.
