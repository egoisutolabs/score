import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusWriter } from "@score/core/daemon/status.service";
import { StatusWriter as RealStatusWriter } from "@score/core/daemon/status.service";
import type { TelemetryRecord, TelemetrySpan } from "@score/core/telemetry/telemetry.interface";
import { TelemetryLogService } from "@score/core/telemetry/telemetry-log.service";
import { createFileLogger } from "@score/shared/file-log";
import type { LogLine } from "@score/shared/log";
import { expect, test } from "vitest";
import { parseDaemonArguments, runDaemonLoop } from "../daemon.run";
import { CaptureLogger, FakeRunner, managedFixture, managedResponsesSeeded } from "../fixtures";
import { TickTelemetryService } from "./telemetry.service";

const SEEDED_ISSUE = 7;

interface LoopRun {
  readonly log: CaptureLogger;
  readonly commands: readonly (readonly string[])[];
}

async function withHomeEnv<T>(home: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.SCORE_HOME;
  process.env.SCORE_HOME = home;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.SCORE_HOME;
    else process.env.SCORE_HOME = saved;
  }
}

async function runOnce(repo: string, home: string): Promise<LoopRun> {
  return withHomeEnv(home, async () => {
    const runner = new FakeRunner(managedResponsesSeeded(repo));
    const log = new CaptureLogger();
    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new RealStatusWriter(join(runsDir, "status.json"));
    const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);
    await runDaemonLoop(parsed, log, { fileLog, status }, { runner });
    return { log, commands: runner.calls.map((call) => call.command) };
  });
}

async function readTelemetry(home: string): Promise<TelemetryRecord[]> {
  const dir = join(home, "projects", "demo", "telemetry");
  const names = await readdir(dir);
  const records: TelemetryRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".jsonl")).sort()) {
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
      if (line !== "") records.push(JSON.parse(line) as TelemetryRecord);
    }
  }
  return records;
}

test("one dry-run pass yields one tick root span with ordered phase children sharing its trace", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await runOnce(repo, home);

  const records = await readTelemetry(home);
  const spans = records.filter((record) => record.kind === "span") as TelemetrySpan[];
  const events = records.filter((record) => record.name.endsWith(".decision"));

  const tick = spans.find((span) => span.name === "score.tick");
  expect(tick).toBeDefined();
  expect(spans.filter((span) => span.name === "score.tick")).toHaveLength(1);
  expect(tick?.resource).toEqual({ project: "demo", daemon_pid: process.pid });

  // Tick 0: all three phases are due, in the daemon's fixed order.
  const phaseNames = spans
    .filter((span) => span.name === "score.phase")
    .map((span) => span.attributes?.["score.phase.name"]);
  expect(phaseNames).toEqual(["cleanup+dispatch", "landing", "repair"]);

  // Every phase span is a child of the tick span and shares its trace.
  const traceId = tick?.attributes?.trace_id;
  expect(typeof traceId).toBe("string");
  for (const span of spans) {
    expect(span.attributes?.trace_id).toBe(traceId);
    expect(span.attributes?.["score.tick.number"]).toBe(0);
    expect(span.attributes?.["score.dry_run"]).toBe(true);
  }
  for (const phase of spans.filter((span) => span.name === "score.phase")) {
    expect(phase.parent_span_id).toBe(tick?.span_id);
  }

  // The seeded issue surfaced as a planned dispatch decision under the same trace.
  expect(events.map((event) => event.name)).toEqual(["score.dispatch.decision"]);
  const decision = events[0];
  expect(decision?.subject).toEqual({ issue_number: SEEDED_ISSUE });
  expect(decision?.attributes?.["score.action"]).toBe("planned");
  expect(decision?.attributes?.trace_id).toBe(traceId);
  expect(decision?.attributes?.["score.dry_run"]).toBe(true);

  // File order is phase-correlated: the dispatch decision precedes the phase
  // spans, and the tick span closes the pass last.
  const order = records.map((record) =>
    record.name === "score.phase"
      ? `phase:${record.attributes?.["score.phase.name"]}`
      : record.name,
  );
  expect(order.indexOf("score.dispatch.decision")).toBeLessThan(
    order.indexOf("phase:cleanup+dispatch"),
  );
  expect(order.at(-1)).toBe("score.tick");
}, 20_000);

test("a JSONL append failure changes no phase result, render output, or phase order", async () => {
  // Both runs share one repo + home: the prose log embeds their paths, so a
  // parity diff is only meaningful over identical fixtures.
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  const control = await runOnce(repo, home);

  // Make every append fail hard: the telemetry segment path exists as a file,
  // so the writer's mkdir/append can never succeed.
  await rm(join(home, "projects", "demo", "telemetry"), { recursive: true, force: true });
  await writeFile(join(home, "projects", "demo", "telemetry"), "not a directory\n");
  const failing = await runOnce(repo, home);

  // Identical phase behavior: same command sequence, same render and summary
  // lines — only the rate-limited telemetry failure warns differ.
  expect(failing.commands).toEqual(control.commands);
  const stripTelemetry = (lines: readonly LogLine[]) =>
    lines.filter(
      (line) =>
        !line.text.startsWith("telemetry append failed") &&
        !line.text.startsWith("telemetry retention sweep failed"),
    );
  expect(stripTelemetry(failing.log.logged)).toEqual(stripTelemetry(control.log.logged));

  // The broken telemetry path (a file where the segment dir belongs) warns
  // exactly once for the sweep and once for the appends inside the interval.
  const sweepWarns = failing.log.logged.filter((line) =>
    line.text.startsWith("telemetry retention sweep failed"),
  );
  expect(sweepWarns).toHaveLength(1);

  // Many appends failed (three phase spans, the tick span, every event), but
  // the failure report is rate-limited to one line inside the interval.
  const failureLines = failing.log.logged.filter((line) =>
    line.text.startsWith("telemetry append failed"),
  );
  expect(failureLines).toHaveLength(1);
  // The failure line carries the active span's correlation ids (epic #58).
  expect(failureLines[0]?.text).toMatch(/trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16}/);

  // No segment directory materialized and no record was stored.
  const stats = await stat(join(home, "projects", "demo", "telemetry"));
  expect(stats.isFile()).toBe(true);
}, 20_000);

test("a failing phase records its span as error with error.type, and the remaining phases still run", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withHomeEnv(home, async () => {
    // Malformed `gh issue list` JSON makes observeIssues throw inside the
    // cleanup+dispatch phase — the exact mid-phase failure path whose span
    // must carry the outcome.
    const runner = new FakeRunner((command) => {
      if (command[0] === "gh" && command[1] === "issue" && command[2] === "list") {
        return { stdout: "{not json\n" };
      }
      return managedResponsesSeeded(repo)(command);
    });
    const log = new CaptureLogger();
    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new RealStatusWriter(join(runsDir, "status.json"));
    const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);

    // The pass completes; the phase error is DaemonService's caught path.
    await runDaemonLoop(parsed, log, { fileLog, status }, { runner });
    expect(
      log.logged.some((line) => line.text.startsWith("✗ phase cleanup+dispatch failed:")),
    ).toBe(true);
  });

  const spans = (await readTelemetry(home)).filter(
    (record) => record.kind === "span",
  ) as TelemetrySpan[];
  const byPhase = new Map(
    spans
      .filter((span) => span.name === "score.phase")
      .map((span) => [span.attributes?.["score.phase.name"], span]),
  );

  // The failed phase's span carries the error outcome and the error's type —
  // recorded in the wrapper's catch, before its finally closes the span. (The
  // throw surfaces as github.service's wrapped plain Error, not the raw
  // SyntaxError; error.type mirrors whatever class actually reached the phase.)
  const failed = byPhase.get("cleanup+dispatch");
  expect(failed?.status).toBe("error");
  expect(failed?.attributes?.["score.outcome"]).toBe("error");
  expect(failed?.attributes?.["error.type"]).toBe("Error");
  expect(JSON.stringify(failed)).not.toContain("invalid JSON");

  // The remaining phases ran after the failure, recorded clean, and the tick
  // root carries the pass error.
  expect(byPhase.get("landing")?.attributes?.["score.outcome"]).toBe("ok");
  expect(byPhase.get("repair")?.attributes?.["score.outcome"]).toBe("ok");
  expect(spans.find((span) => span.name === "score.tick")?.attributes?.["score.outcome"]).toBe(
    "error",
  );
}, 20_000);

test("a fatal pass-START status write still lands an error tick record", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withHomeEnv(home, async () => {
    const runner = new FakeRunner(managedResponsesSeeded(repo));
    const log = new CaptureLogger();
    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    // The pass-start write (state: "running") fails — the earlier "starting"
    // heartbeat at loop entry still succeeds. The pass exits before any phase
    // runs, but after the tick span opened.
    const status = {
      write: (partial: { state?: string }) =>
        partial.state === "running"
          ? Promise.reject(new Error("tmp unwritable"))
          : Promise.resolve(),
      settle: () => Promise.resolve(),
    } as unknown as StatusWriter;
    const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);

    await expect(runDaemonLoop(parsed, log, { fileLog, status }, { runner })).rejects.toThrow(
      "tmp unwritable",
    );
  });

  // The root span exists and records the exceptional exit as an error pass —
  // no phase spans, exactly one trace for the aborted tick.
  const spans = (await readTelemetry(home)).filter(
    (record) => record.kind === "span",
  ) as TelemetrySpan[];
  expect(spans.filter((span) => span.name === "score.tick")).toHaveLength(1);
  const tick = spans.find((span) => span.name === "score.tick");
  expect(tick?.attributes?.["score.outcome"]).toBe("error");
  expect(spans.filter((span) => span.name === "score.phase")).toEqual([]);
}, 20_000);

test("a fatal pass exit still closes the tick span, marked as an error pass", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withHomeEnv(home, async () => {
    const runner = new FakeRunner(managedResponsesSeeded(repo));
    const log = new CaptureLogger();
    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    // The pass-starting writes succeed; the end-of-pass write fails, so the
    // tick callback exits through its catch after the phase spans landed.
    const status = {
      write: (partial: Record<string, unknown>) =>
        partial.last_pass_completed_at === undefined
          ? Promise.resolve()
          : Promise.reject(new Error("disk full")),
      settle: () => Promise.resolve(),
    } as unknown as StatusWriter;
    const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);

    await expect(runDaemonLoop(parsed, log, { fileLog, status }, { runner })).rejects.toThrow(
      "disk full",
    );
  });

  // The root span closed despite the exception: every phase span sits under
  // one trace, and the tick is recorded as an error pass.
  const spans = (await readTelemetry(home)).filter(
    (record) => record.kind === "span",
  ) as TelemetrySpan[];
  const tick = spans.find((span) => span.name === "score.tick");
  expect(tick?.attributes?.["score.outcome"]).toBe("error");
  const traceId = tick?.attributes?.trace_id;
  for (const phase of spans.filter((span) => span.name === "score.phase")) {
    expect(phase.attributes?.trace_id).toBe(traceId);
    expect(phase.parent_span_id).toBe(tick?.span_id);
  }
}, 20_000);

test("retention re-sweeps on UTC rollover at tick start — not only at daemon startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-telemetry-"));
  // Inside the 30-day window on Aug 15 (cutoff Jul 16); stale after Aug 20.
  await writeFile(join(dir, "2026-07-20.jsonl"), "{}\n");
  let clock = new Date("2026-08-15T12:00:00Z");
  const writer = new TelemetryLogService(dir, { project: "demo" }, () => clock);
  const telemetry = new TickTelemetryService(
    writer,
    { project: "demo" },
    true,
    {},
    {
      sweep: () => writer.sweepRetention(30),
      now: () => clock,
    },
  );

  // The startup sweep ran; the in-window segment survives it.
  expect(existsSync(join(dir, "2026-07-20.jsonl"))).toBe(true);

  telemetry.beginTick(0);
  telemetry.beginPhase("repair");
  telemetry.repairDecisions([]);
  telemetry.endPhase();
  telemetry.endTick(null);
  // Same UTC day: no rollover, the segment stays, and the pass's records
  // landed in that day's segment.
  expect(existsSync(join(dir, "2026-07-20.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "2026-08-15.jsonl"))).toBe(true);

  // Days pass while the daemon keeps running; the next tick observes the
  // rollover and re-sweeps the now-stale segment without a restart.
  clock = new Date("2026-08-21T00:00:30Z");
  telemetry.beginTick(1);
  expect(existsSync(join(dir, "2026-07-20.jsonl"))).toBe(false);
  // And the running daemon keeps appending into the new day's segment.
  telemetry.beginPhase("repair");
  telemetry.repairDecisions([]);
  telemetry.endPhase();
  telemetry.endTick(null);
  expect(existsSync(join(dir, "2026-08-21.jsonl"))).toBe(true);
  await rm(dir, { recursive: true, force: true });
});

test("a failed sweep is retried by the next tick without disabling recording", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-telemetry-"));
  await writeFile(join(dir, "2026-07-20.jsonl"), "{}\n"); // stale at 30 days
  const clock = new Date("2026-08-21T12:00:00Z");
  const writer = new TelemetryLogService(dir, { project: "demo" }, () => clock);
  const reported: string[] = [];
  let failSweep = true;
  const telemetry = new TickTelemetryService(
    writer,
    { project: "demo" },
    true,
    {},
    {
      sweep: () => {
        if (failSweep) throw new Error("permission denied");
        writer.sweepRetention(30);
      },
      now: () => clock,
      mono: () => 0,
      onError: (message) => reported.push(message),
    },
  );

  // The startup sweep failed and warned — but recording stayed live.
  expect(reported).toHaveLength(1);
  expect(reported[0]).toContain("telemetry retention sweep failed");
  telemetry.beginTick(0);
  telemetry.beginPhase("repair");
  telemetry.repairDecisions([]);
  telemetry.endPhase();
  telemetry.endTick(null);
  const mid = new TelemetryLogService(dir, { project: "demo" }, () => clock);
  expect(mid.read(mid.startCursor()).records.length).toBeGreaterThan(0);

  // The transient failure heals (operator restored permissions); the SAME
  // process's next tick retries the unswept day and the stale segment goes.
  failSweep = false;
  telemetry.beginTick(1);
  expect(existsSync(join(dir, "2026-07-20.jsonl"))).toBe(false);
  // And exactly one warn for the whole episode — not one per retrying tick.
  expect(reported).toHaveLength(1);
  await rm(dir, { recursive: true, force: true });
});

test("span durations come from the monotonic clock — a wall-clock step never corrupts them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-telemetry-"));
  let wall = new Date("2026-08-15T12:00:00Z");
  let mono = 1_000;
  const writer = new TelemetryLogService(dir, { project: "demo" }, () => wall);
  const telemetry = new TickTelemetryService(
    writer,
    { project: "demo" },
    true,
    {},
    { now: () => wall, mono: () => mono },
  );

  telemetry.beginTick(0);
  telemetry.beginPhase("repair");
  mono += 250;
  // An NTP step moves the wall clock backwards mid-span; durations must not
  // follow it.
  wall = new Date("2026-08-15T11:00:00Z");
  telemetry.repairDecisions([]);
  telemetry.endPhase();
  mono += 250;
  telemetry.endTick(null);

  const read = new TelemetryLogService(dir, { project: "demo" }, () => wall);
  const spans = read.read(read.startCursor()).records.filter((record) => record.kind === "span");
  for (const span of spans) {
    expect((span as { duration_ms: number }).duration_ms).toBeGreaterThan(0);
  }
  expect(
    (spans.find((span) => span.name === "score.tick") as { duration_ms: number }).duration_ms,
  ).toBe(500);
  expect(
    (spans.find((span) => span.name === "score.phase") as { duration_ms: number }).duration_ms,
  ).toBe(250);
  await rm(dir, { recursive: true, force: true });
});

test("a telemetry-side failure disables recording without ever throwing into the pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-telemetry-"));
  const reported: string[] = [];
  const writer = new TelemetryLogService(dir, { project: "demo" });
  const telemetry = new TickTelemetryService(
    writer,
    { project: "demo" },
    true,
    {},
    {
      // Random-id generation is the failure point: ids come from the OS.
      now: () => {
        throw new Error("entropy exhausted");
      },
      onError: (message) => reported.push(message),
    },
  );

  expect(() => telemetry.beginTick(0)).not.toThrow();
  expect(() => telemetry.beginPhase("repair")).not.toThrow();
  expect(() => telemetry.repairDecisions([])).not.toThrow();
  expect(() => telemetry.endPhase()).not.toThrow();
  expect(() => telemetry.endTick(null)).not.toThrow();
  expect(reported).toHaveLength(1);
  // Nothing was recorded — the recorder is disabled, not half-alive.
  expect((await readdir(dir)).length).toBe(0);
  await rm(dir, { recursive: true, force: true });
});

test("a throwing telemetry reporter never escapes into a phase or the pass loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-telemetry-"));
  const writer = new TelemetryLogService(dir, { project: "demo" });
  const telemetry = new TickTelemetryService(
    writer,
    { project: "demo" },
    true,
    {},
    {
      // Both the sweep and its reporter fail; neither may throw outward.
      sweep: () => {
        throw new Error("permission denied");
      },
      now: () => {
        throw new Error("entropy exhausted");
      },
      onError: () => {
        throw new Error("reporter writes to the same dead disk");
      },
    },
  );

  expect(() => telemetry.beginTick(0)).not.toThrow();
  expect(() => telemetry.beginPhase("repair")).not.toThrow();
  expect(() => telemetry.repairDecisions([])).not.toThrow();
  expect(() => telemetry.endPhase()).not.toThrow();
  expect(() => telemetry.endTick(null)).not.toThrow();
  // Nothing recorded — the recorder disabled itself on the first failure.
  expect((await readdir(dir)).length).toBe(0);
  await rm(dir, { recursive: true, force: true });
});

test("decisions are recorded before the fallible prose sink", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withHomeEnv(home, async () => {
    const runner = new FakeRunner(managedResponsesSeeded(repo));
    // The prose logger throws on the FIRST phase-render — after that phase's
    // external work completed — then recovers, so the rest of the pass runs
    // and the loop settles normally.
    const log = new CaptureLogger();
    const realLines = log.lines.bind(log);
    let broken = true;
    log.lines = (lines) => {
      if (broken) {
        broken = false;
        throw new Error("prose log disk full");
      }
      realLines(lines);
    };
    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new RealStatusWriter(join(runsDir, "status.json"));
    const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);

    await runDaemonLoop(parsed, log, { fileLog, status }, { runner });
  });

  // The structured decision for the planned issue survived the prose failure
  // — the log-path error erased no evidence of the phase's actions.
  const records = await readTelemetry(home);
  const decisions = records.filter((record) => record.name === "score.dispatch.decision");
  expect(decisions.map((decision) => decision.attributes?.["score.action"])).toContain("planned");
}, 20_000);

test("cleanup decisions survive a dispatch failure inside the maintenance phase", async () => {
  const repo = await mkdtemp(join(tmpdir(), "score-repo-"));
  const { home } = await managedFixture(repo);
  await withHomeEnv(home, async () => {
    const mergedPr = JSON.stringify({
      number: 9,
      headRefName: "issue-9-fix-the-thing",
      mergedAt: "2026-08-15T10:00:00Z",
    });
    const runner = new FakeRunner((command) => {
      // One merged PR with no worktree → cleanup records NOT_FOUND, then
      // dispatch's candidate observation dies on malformed JSON.
      if (command[0] === "gh" && command[1] === "pr" && command[2] === "list") {
        return command.includes("merged") ? { stdout: `[${mergedPr}]\n` } : { stdout: "[]\n" };
      }
      if (command[0] === "gh" && command[1] === "issue" && command[2] === "list") {
        return { stdout: "{not json\n" };
      }
      return managedResponsesSeeded(repo)(command);
    });
    const log = new CaptureLogger();
    const runsDir = await mkdtemp(join(tmpdir(), "score-runs-"));
    const fileLog = createFileLogger(join(runsDir, "logs"), false);
    const status = new RealStatusWriter(join(runsDir, "status.json"));
    const parsed = parseDaemonArguments(["--project", "demo", "--once", "--dry-run"]);

    await runDaemonLoop(parsed, log, { fileLog, status }, { runner });
    // The phase failed loudly, with the underlying cause's message.
    expect(
      log.logged.some(
        (line) =>
          line.level === "warn" &&
          line.text.startsWith("✗ phase cleanup+dispatch failed: gh returned invalid JSON"),
      ),
    ).toBe(true);
  });

  const records = await readTelemetry(home);
  // The cleanup decision for the observed merged PR survived the dispatch
  // failure — the mutation evidence rode the error into the trace.
  const cleanupDecision = records.find((record) => record.name === "score.cleanup.decision");
  expect(cleanupDecision?.subject).toEqual({ pull_request_number: 9 });
  expect(cleanupDecision?.attributes?.["score.action"]).toBe("NOT_FOUND");
  // No dispatch events were fabricated from the failed half of the tick.
  expect(records.some((record) => record.name === "score.dispatch.decision")).toBe(false);
  // The phase span still records the failure, under the same trace.
  const spans = records.filter((record) => record.kind === "span") as TelemetrySpan[];
  const failedPhase = spans.find(
    (span) => span.attributes?.["score.phase.name"] === "cleanup+dispatch",
  );
  expect(failedPhase?.attributes?.["score.outcome"]).toBe("error");
  expect(failedPhase?.attributes?.trace_id).toBe(cleanupDecision?.attributes?.trace_id);
}, 20_000);

test("unmanaged discovery mode records nothing — no project key to segment under", async () => {
  const home = await mkdtemp(join(tmpdir(), "score-home-"));
  const saved = process.env.SCORE_HOME;
  process.env.SCORE_HOME = home;
  try {
    const runner = new FakeRunner((command) => {
      if (command[1] === "rev-parse" && command.includes("--abbrev-ref")) return { exitCode: 1 };
      if (command[1] === "rev-parse") return { stdout: "/repos/score\n" };
      if (command[1] === "repo") return { stdout: '{"nameWithOwner":"owner/score"}\n' };
      return {};
    });
    const log = new CaptureLogger();
    // A phase that throws on the empty fake backlog is DaemonService's normal
    // caught-error path; --once still completes the pass and exits cleanly.
    await runDaemonLoop(parseDaemonArguments(["--once", "--dry-run"]), log, undefined, { runner });

    // No project directory — hence no telemetry segments — was ever created.
    expect(
      await stat(join(home, "projects")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.SCORE_HOME;
    else process.env.SCORE_HOME = saved;
  }
});

test("no phase module imports the telemetry log writer; no OTel SDK ships anywhere", async () => {
  const phaseFeatures = ["cleanup", "dispatch", "landing", "repair"] as const;
  for (const feature of phaseFeatures) {
    const dir = new URL(`../../../../../packages/core/src/${feature}/`, import.meta.url);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(new URL(name, dir), "utf8");
      expect(source.includes("telemetry")).toBe(false);
    }
  }
  // Every workspace manifest, not just the root: the daemon, the libraries,
  // and any future app must each stay free of an OTel SDK dependency.
  const packageRoot = new URL("../../../../../", import.meta.url);
  const manifests = ["package.json"];
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(new URL(group, packageRoot), { withFileTypes: true })) {
      if (entry.isDirectory()) manifests.push(`${group}/${entry.name}/package.json`);
    }
  }
  for (const manifest of manifests) {
    const raw = await readFile(new URL(manifest, packageRoot), "utf8");
    expect(raw.toLowerCase()).not.toContain("opentelemetry");
  }
});
