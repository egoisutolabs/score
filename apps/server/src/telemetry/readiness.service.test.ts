import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ReadinessResult } from "./readiness.service";
import { ReadinessService } from "./readiness.service";

const TODAY = "2026-08-15";
const now = () => new Date(`${TODAY}T12:00:00Z`);
const goodConfig = '{"key":"alpha"}\n';
const goodLine = '{"v":1,"signal":"event","name":"score.daemon.started"}\n';

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "score-readyz-"));
  sandboxes.push(path);
  return path;
}

/** Writes root/<key>/<relative path> for each entry, creating parents. */
function seedProject(root: string, key: string, files: Record<string, string>): void {
  mkdirSync(join(root, key), { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const path = join(root, key, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

interface MatrixCase {
  readonly name: string;
  readonly seed: (root: string) => void;
  /** Overrides the projects dir handed to the service; defaults to the sandbox root. */
  readonly dir?: (root: string) => string;
  readonly expected: ReadinessResult;
}

// Unreadability fixtures use wrong filesystem shapes (a directory where a
// file belongs, a file where a directory belongs) instead of chmod 0o000,
// which root — as in containerized CI — reads straight through.

const matrix: MatrixCase[] = [
  {
    name: "parsing config + readable today segment → ready",
    seed: (root) =>
      seedProject(root, "alpha", {
        "resolved.json": goodConfig,
        [`telemetry/${TODAY}.jsonl`]: goodLine,
      }),
    expected: { ready: true },
  },
  {
    name: "unparseable config → CONFIG_UNPARSEABLE",
    seed: (root) => seedProject(root, "alpha", { "resolved.json": "{not json" }),
    expected: { ready: false, reason: "CONFIG_UNPARSEABLE" },
  },
  {
    name: "unreadable existing config → CONFIG_UNPARSEABLE",
    seed: (root) => mkdirSync(join(root, "alpha", "resolved.json"), { recursive: true }),
    expected: { ready: false, reason: "CONFIG_UNPARSEABLE" },
  },
  {
    name: "unreadable existing segment → SEGMENT_UNREADABLE",
    seed: (root) => {
      seedProject(root, "alpha", { "resolved.json": goodConfig });
      mkdirSync(join(root, "alpha", "telemetry", `${TODAY}.jsonl`), { recursive: true });
    },
    expected: { ready: false, reason: "SEGMENT_UNREADABLE" },
  },
  {
    name: "unparseable first segment line → SEGMENT_UNREADABLE",
    seed: (root) =>
      seedProject(root, "alpha", {
        "resolved.json": goodConfig,
        [`telemetry/${TODAY}.jsonl`]: `not json\n${goodLine}`,
      }),
    expected: { ready: false, reason: "SEGMENT_UNREADABLE" },
  },
  {
    name: "garbage beyond the first line → ready (first line is the ceiling)",
    seed: (root) =>
      seedProject(root, "alpha", {
        "resolved.json": goodConfig,
        [`telemetry/${TODAY}.jsonl`]: `${goodLine}not json\n`,
      }),
    expected: { ready: true },
  },
  {
    name: "first line spanning multiple read chunks still parses → ready",
    seed: (root) =>
      seedProject(root, "alpha", {
        "resolved.json": goodConfig,
        [`telemetry/${TODAY}.jsonl`]: `${JSON.stringify({ v: 1, body: "x".repeat(70_000) })}\n`,
      }),
    expected: { ready: true },
  },
  {
    name: "segment holding only an incomplete tail → ready (readers withhold it)",
    seed: (root) =>
      seedProject(root, "alpha", {
        "resolved.json": goodConfig,
        [`telemetry/${TODAY}.jsonl`]: '{"v":1,"torn',
      }),
    expected: { ready: true },
  },
  {
    name: "project dir without resolved.json → CONFIG_UNPARSEABLE (absence-ready covers telemetry only)",
    seed: (root) => seedProject(root, "alpha", {}),
    expected: { ready: false, reason: "CONFIG_UNPARSEABLE" },
  },
  {
    name: "projects path that is no directory → CONFIG_UNPARSEABLE (enumeration failure is not absence)",
    seed: (root) => writeFileSync(join(root, "projects"), ""),
    dir: (root) => join(root, "projects"),
    expected: { ready: false, reason: "CONFIG_UNPARSEABLE" },
  },
  {
    name: "absent telemetry dir → ready",
    seed: (root) => seedProject(root, "alpha", { "resolved.json": goodConfig }),
    expected: { ready: true },
  },
  {
    name: "absent today segment beside a corrupt older one → ready (no historical scan)",
    seed: (root) =>
      seedProject(root, "alpha", {
        "resolved.json": goodConfig,
        "telemetry/2026-08-14.jsonl": "not json\n",
      }),
    expected: { ready: true },
  },
  {
    name: "absent projects dir → ready",
    seed: () => {},
    expected: { ready: true },
  },
  {
    name: "any project failing fails the fleet → CONFIG_UNPARSEABLE",
    seed: (root) => {
      seedProject(root, "alpha", { "resolved.json": goodConfig });
      seedProject(root, "beta", { "resolved.json": "{not json" });
    },
    expected: { ready: false, reason: "CONFIG_UNPARSEABLE" },
  },
];

for (const entry of matrix) {
  test(`readyz matrix: ${entry.name}`, () => {
    const root = sandbox();
    entry.seed(root);
    expect(new ReadinessService(entry.dir?.(root) ?? root, now).check()).toEqual(entry.expected);
  });
}
