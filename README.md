# Score

One daemon runs the whole issue → PR → green → merged pipeline:

```sh
# from the repo root: cleanup + dispatch every tick, landing every 2 ticks, repair every tick
bun run start
```

```sh
bun run start --once --dry-run --verbose --no-merge
```

`--once` runs one full pass of every phase and exits. `--dry-run` reports what
each phase would do without touching a session, a worktree, or a branch.
`--no-merge` lets landing gate and soak but never commit the merge.

Score has exactly one contract with every project it cranks: the repo exposes
**`make verify`** at its root, running that project's full verification (check,
tests, build — whatever the repo deems necessary) and exiting nonzero on
failure. Landing's merged-tree gate runs it before any merge, and agent
briefings point at it; the recipe lives in the repo's own Makefile, versioned
with the code, so Score carries zero language assumptions — Bun, Go, Rust, all
the same to it. A repo without the target never merges.

Phases run strictly in order within a pass — **cleanup → dispatch → landing →
repair** — which keeps the primary checkout single-writer and preserves the
legacy authority split: dispatch never merges, landing never edits code, repair
never merges. A phase that throws is logged and the pass continues. Out-of-scope
bugs found by implementers arrive as `triage`-labeled issues, which dispatch
refuses outright — whatever the eligible label prefix — until the planned
triage stage (not yet a pass phase) rewrites them into `epic:` work.

Landing stages the exact head SHA it vetted (never the mutable branch name) and
soaks per commit: a new push mid-soak restarts the count from zero, and an
observation without a head SHA is refused outright. Every command the daemon
runs is bounded by a deadline (120s default, 30min for `make verify`) and killed
as a whole process tree on timeout — a hung `gh` or wedged verify can't stall a
phase.

`repair` also stays a manual one-shot, for when a specific PR needs a nudge now:

```sh
bun run start repair --only 12,14 --dry-run --include-clean --no-spawn
```

Under the daemon, repair leaves a PR alone while the agent it already pinged is
still working on it — session alive, nothing pushed, defects unchanged, and
fewer than `REPAIR_STALE_TICKS` ticks since the ping. The manual subcommand has
no such ledger and always acts.

Cleanup runs the same clock over issue worktrees with no PR at all: after
`REPAIR_STALE_TICKS` ticks with no new commits the agent is pinged, and after a
second silent window — or immediately once its session is gone — a worktree
that is clean and has no commits ahead of base is reclaimed so the issue
redispatches. A worktree holding real work is never removed: while its agent
is alive it is reported loudly every tick, and once the agent is gone a fresh
agent is respawned in place to finish the preserved work.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `TICK_INTERVAL_MS` | `60000` | The daemon's only clock; phases declare tick multiples. |
| `SOAK_TICKS` | `2` | Consecutive green landing ticks before a merge. |
| `REPAIR_STALE_TICKS` | `10` | Ticks before a silent agent is re-pinged; also each window of cleanup's stranded ladder (ping, then reclaim a clean no-PR worktree). |
| `MAX_PARALLEL` | `1` | Issues in flight at once. |
| `MAX_MERGES` | `5` | Merges per landing tick. |
| `SKIP_LABELS` | `hold,wip,do-not-merge` | Labels landing refuses to merge. |
| `WORKTREE_ROOT` | `~/wt` | Parent of the per-repo worktree directory. |
| `EPIC_LABEL_PREFIX` | `epic:` | Label prefix marking dispatchable issues. |
| `AGENT_CMD` | `claude` | Command repair spawns in a worktree. |
| `SCORE_SERVER_URL` | `http://127.0.0.1:3000` | Read-only API used by `score tui`. |

Others keep their legacy names and defaults (`GH_REPO`, `AUTO_PULL_MAIN`,
`ONLY_ISSUE_BRANCHES`, `SESSION_SUFFIX`); see `apps/daemon/src/daemon/daemon.run.ts`
and `apps/daemon/src/repair/repair.run.ts`.

## Managed mode

`score config init` writes `~/.score/config.jsonc`; `score up <project>` ensures
the fleet's loopback API is running and runs the project daemon supervised
(launchd/systemd), reading only that project's `resolved.json` — no env tuning.
Each project's `agent.harness` is either
`"claude"` (tmux sessions, unchanged) or `"opencode"` (a durable HTTP session
per issue against a locally-owned `opencode serve` child):

```jsonc
"score": {
  // ...
  "config": {
    "agent": { "harness": "opencode", "model": "anthropic/claude-sonnet-5" },
    // ...
  },
},
```

### One child per daemon

A managed `harness: "opencode"` project starts exactly one `opencode serve`
child before the poll loop begins, and every phase (cleanup, dispatch, repair)
shares that same `OpencodeService` instance — sessions are addressed by exact
title, never by a locally-cached ID, so a restart resolves the same
conversation instead of creating a new one. Bootstrap preflights `opencode
--version` (in place of `tmux -V`) and refuses to start if
`OPENCODE_SERVER_PASSWORD` is set — the adapter has no HTTP auth support in
v1, so a passworded child would spawn and then be unreachable. `--dry-run`
still starts and stops the child (so the lifecycle is exercised end to end)
while every create/prompt/abort/delete call is suppressed.

### Unexpected exit is fatal, never mid-phase

If the child dies without the daemon having asked it to stop, the current
phase is allowed to finish, the rest of that pass is skipped, and the daemon
logs `fatal: opencode child exited unexpectedly`, writes it to
`status.last_error`, and exits nonzero. The supervisor restarts the process;
because opencode sessions are durable and title-addressed, the new daemon
resolves the exact same session by title and resumes it with its prior
context intact — the same shutdown path SIGTERM already used, just triggered
by the child instead of a signal.

### Real-binary smoke

Verified manually against `opencode 1.17.15` (`opencode serve --hostname
127.0.0.1 --port 0`), driving the same HTTP calls `OpencodeService` makes:

1. **Create**: `POST /session` with `title: "score-demo-smoke-1"` → session
   `ses_0101ed83cffe375BS6n4I31fgr`.
2. **Prompt**: `POST /session/{id}/prompt_async`, *"Reply with exactly one
   word and nothing else: pineapple"* → assistant replies `pineapple`.
3. **Kill child**: `kill -9` the `opencode serve` process — the next request
   against its port refuses the connection.
4. **Restart**: a fresh `opencode serve` starts on a new port.
5. **Resolve same title**: `GET /api/session?search=score-demo-smoke-1`
   returns exactly one match — the same `ses_0101ed83cffe375BS6n4I31fgr`.
6. **Resume**: `POST /session/{id}/prompt_async`, *"What single word did you
   reply with earlier in this conversation? Answer with just that word."*
   → assistant replies `pineapple`, proving the resumed session retained the
   pre-restart context rather than starting a fresh conversation:

   ```
   user:      Reply with exactly one word and nothing else: pineapple
   assistant: pineapple
   [child killed, opencode serve restarted, same title resolved]
   user:      What single word did you reply with earlier in this conversation? Answer with just that word.
   assistant: pineapple
   ```

## Supervisor platforms

`score up / down / tui` pick the supervisor by platform: launchd
(`~/Library/LaunchAgents`) on macOS, systemd user units
(`~/.config/systemd/user/score-<key>.service`) on Linux. Other platforms are
unsupported and fail before touching anything.

The TUI reads fleet snapshots, dated log records, daemon telemetry, and GitHub
merge history through `apps/server`; it does not open project state or log files
or invoke `gh` itself. `score up` installs one fleet-level loopback server
alongside the project daemons, so `score tui` needs no separate server command.
`bun run server:start` remains the foreground development path, and
`SCORE_SERVER_URL` can point the TUI at another Score server. Lifecycle keys still
call the local supervisor adapter directly because the API remains read-only.

On Linux, systemd user units are killed at logout unless lingering is enabled.
Run this once per operator account, or the daemons die with your SSH session:

```sh
loginctl enable-linger $USER
```

`score doctor` deliberately does not check this — it is documented, not
enforced.

## Layout

Bun workspaces + Turborepo. `apps/{daemon,tui,server}` are entry points (the
`score` CLI is `apps/daemon`; `tui` is the Ink terminal viewer; `server` is the API-only Express app);
`packages/{shared,core,agents,tracker}` are libraries — ports live in `core`,
implementations in `agents`/`tracker`. Files are named `<noun>.<role>.ts`
(`.service`, `.policy`, `.render`, `.interface`, `.run`); see `AGENTS.md`.

## Verify

```sh
bun run check
bun run test
bun run build
```

## License

Copyright (C) 2026 egoisutolabs.com

Score is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free
Software Foundation, version 3 of the License only. See [LICENSE](LICENSE)
for the full text.
