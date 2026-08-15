# Operating Score over SSH (post-TUI)

Lifecycle authority lives in the CLI/supervisor path and nowhere else
(locked decisions 6 and 7, epic #58). No HTTP route can install, start,
stop, or restart a job — `supervisor.run.test.ts` enforces this with a
negative scan over the HTTP-facing apps. Remote operation is therefore
SSH plus the CLI, with an optional read-only tunnel for the telemetry
API once it exists.

## Controls

```sh
ssh <host>
score up [key]      # reconcile config → supervisor; starts/restarts on drift
score down [key]    # stop and deregister (all jobs without a key)
score restart <key> # forced stop → install → start of one enabled project
score doctor        # environment and supervisor health
```

`up` is the primary control: it converges the supervisor to the config and
is a no-op when nothing changed. `restart` exists for the case `up` cannot
express — a wedged daemon whose config is unchanged. It refuses disabled or
unknown projects, and it reads the saved job definition *before* stopping,
so a missing definition can never boot out a job it cannot bring back
(`INVARIANTS.md`, audited writers).

## Observation (optional loopback tunnel)

The telemetry API (epic #58) binds to loopback only. To read it from your
workstation, tunnel the port instead of exposing it:

```sh
ssh -N -L <port>:127.0.0.1:<port> <host>
```

The tunnel is observation only. Control never moves into HTTP; mutating a
project always means the CLI over SSH.
