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
never merges. A phase that throws is logged and the pass continues.

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

## Environment

| Variable | Default | What it does |
|---|---|---|
| `TICK_INTERVAL_MS` | `60000` | The daemon's only clock; phases declare tick multiples. |
| `SOAK_TICKS` | `2` | Consecutive green landing ticks before a merge. |
| `REPAIR_STALE_TICKS` | `10` | Ticks before a silent agent is re-pinged. |
| `MAX_PARALLEL` | `1` | Issues in flight at once. |
| `MAX_MERGES` | `5` | Merges per landing tick. |
| `SKIP_LABELS` | `hold,wip,do-not-merge` | Labels landing refuses to merge. |
| `WORKTREE_ROOT` | `~/wt` | Parent of the per-repo worktree directory. |
| `EPIC_LABEL_PREFIX` | `epic:` | Label prefix marking dispatchable issues. |
| `AGENT_CMD` | `claude` | Command repair spawns in a worktree. |

Others keep their legacy names and defaults (`GH_REPO`, `AUTO_PULL_MAIN`,
`ONLY_ISSUE_BRANCHES`, `SESSION_SUFFIX`); see `apps/daemon/src/daemon/daemon.run.ts`
and `apps/daemon/src/repair/repair.run.ts`.

## Supervisor platforms

`score up / down / tui` pick the supervisor by platform: launchd
(`~/Library/LaunchAgents`) on macOS, systemd user units
(`~/.config/systemd/user/score-<key>.service`) on Linux. Other platforms are
unsupported and fail before touching anything.

On Linux, systemd user units are killed at logout unless lingering is enabled.
Run this once per operator account, or the daemons die with your SSH session:

```sh
loginctl enable-linger $USER
```

`score doctor` deliberately does not check this — it is documented, not
enforced.

## Layout

Bun workspaces + Turborepo. `apps/{daemon,tui,server}` are entry points (the
`score` CLI is `apps/daemon`; `server` is a future-HTTP stub);
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
