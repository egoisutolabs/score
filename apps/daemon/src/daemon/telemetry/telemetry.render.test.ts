import { readFile } from "node:fs/promises";

import { BRIEFING_VERSION, briefingVersionFor } from "@score/core/prompts/index";
import type { TelemetryEvent } from "@score/core/telemetry/telemetry.interface";
import { TELEMETRY_VERSION } from "@score/core/telemetry/telemetry.interface";
import { recordViolations } from "@score/core/telemetry/telemetry.policy";
import { describe, expect, test } from "vitest";

import type { ExpectedRecord, MappingRow } from "./fixtures/telemetry.fixture";
import { cleanupRows, dispatchRows, landingRows, repairRows } from "./fixtures/telemetry.fixture";
import type { TelemetryRenderContext } from "./telemetry.render";
import {
  renderCleanupTelemetry,
  renderDispatchTelemetry,
  renderFindingTelemetry,
  renderLandingTelemetry,
  renderMaintenanceTickTelemetry,
  renderOpenAtMergeTelemetry,
  renderParkedTelemetry,
  renderRepairTelemetry,
  renderRepairWaveTelemetry,
} from "./telemetry.render";

const TS = "2026-08-15T00:00:00Z";

function complete(expected: ExpectedRecord, ctx: TelemetryRenderContext): TelemetryEvent {
  return {
    v: TELEMETRY_VERSION,
    ts: ctx.ts,
    project: ctx.project,
    signal: "event",
    name: expected.name,
    subject: expected.subject,
    attributes: { ...expected.attributes, dry_run: ctx.dryRun },
    ...(expected.body === undefined ? {} : { body: expected.body }),
  };
}

function assertTable<Input>(
  rows: readonly MappingRow<Input>[],
  render: (input: Input, ctx: TelemetryRenderContext) => readonly TelemetryEvent[],
) {
  // Every row runs under both passes: dry-run records must be unmistakable,
  // real records must not claim dry_run.
  for (const dryRun of [false, true]) {
    const ctx: TelemetryRenderContext = { project: "score", ts: TS, dryRun, harness: "claude" };
    for (const row of rows) {
      test(`${row.label} (dryRun: ${dryRun})`, () => {
        const records = render(row.input, ctx);
        expect(records).toEqual(row.expected.map((expected) => complete(expected, ctx)));
        for (const record of records) expect(recordViolations(record)).toEqual([]);
      });
    }
  }
}

describe("cleanup results", () => assertTable(cleanupRows, renderCleanupTelemetry));
describe("dispatch results", () => assertTable(dispatchRows, renderDispatchTelemetry));
describe("landing results", () => assertTable(landingRows, renderLandingTelemetry));
describe("repair results", () => assertTable(repairRows, renderRepairTelemetry));

test("a dispatch start carries the briefing version of the harness it was sent to", () => {
  const ctx: TelemetryRenderContext = {
    project: "score",
    ts: TS,
    dryRun: false,
    harness: "opencode",
  };
  const dispatch = dispatchRows[0];
  if (!dispatch) throw new Error("fixture table is empty");
  const [record] = renderDispatchTelemetry(dispatch.input, ctx);
  expect(record?.attributes?.briefing_version).toBe(briefingVersionFor("opencode"));
  expect(record?.attributes?.briefing_version).not.toBe(BRIEFING_VERSION);
});

test("a maintenance tick maps cleanup records before dispatch records", () => {
  const ctx: TelemetryRenderContext = {
    project: "score",
    ts: TS,
    dryRun: false,
    harness: "claude",
  };
  const cleanup = cleanupRows[0];
  const dispatch = dispatchRows[0];
  if (!cleanup || !dispatch) throw new Error("fixture tables are empty");
  expect(
    renderMaintenanceTickTelemetry({ cleanup: [cleanup.input], dispatch: dispatch.input }, ctx),
  ).toEqual([
    ...cleanup.expected.map((expected) => complete(expected, ctx)),
    ...dispatch.expected.map((expected) => complete(expected, ctx)),
  ]);
});

test("phase-folder imports are type-only result interfaces", async () => {
  const source = await readFile(new URL("./telemetry.render.ts", import.meta.url), "utf8");
  // Three shapes reach other modules: import-from, bare side-effect imports,
  // and export-from re-exports. Only the first can be type-only, so matching
  // all three makes the other two fail the type-only assertion below.
  const imports = [
    ...(source.match(/^import[\s\S]*?from\s+"[^"]+";$/gm) ?? []),
    ...(source.match(/^import\s+"[^"]+";$/gm) ?? []),
    ...(source.match(/^export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+"[^"]+";$/gm) ?? []),
  ];
  const phaseImports = imports.filter((statement) =>
    /["/](cleanup|dispatch|landing|repair|maintenance)\//.test(statement),
  );
  // The mapper must import the result types — an empty match would mean the
  // grep no longer sees what it guards.
  expect(phaseImports.length).toBeGreaterThan(0);
  const allowed = new Set([
    "@score/core/cleanup/cleanup-result.interface",
    "@score/core/dispatch/dispatch-result.interface",
    "@score/core/landing/change.interface",
    "@score/core/maintenance/maintenance.service",
    "@score/core/repair/repair-result.interface",
    // Review-loop records map the ledger's own shapes, interfaces both.
    "@score/core/repair/findings/finding.interface",
    "@score/core/repair/wave.interface",
  ]);
  for (const statement of phaseImports) {
    expect(statement.startsWith("import type")).toBe(true);
    const specifier = /from\s+"([^"]+)";$/.exec(statement)?.[1];
    expect(specifier !== undefined && allowed.has(specifier)).toBe(true);
  }
});

describe("review-loop records", () => {
  const ctx: TelemetryRenderContext = {
    project: "score",
    ts: TS,
    dryRun: false,
    harness: "claude",
  };

  test("a wave record carries the ledger's wave state on the PR subject", () => {
    const records = renderRepairWaveTelemetry(
      9,
      2,
      {
        at: TS,
        tick: 4,
        headSha: "abc123",
        defects: { conflicting: false, unresolvedThreads: 3, failingChecks: 1, buildRed: "tsc" },
        openFindings: 5,
        diffSize: 240,
        promptVersion: "c6be2072b02c",
      },
      ctx,
    );
    expect(records).toEqual([
      complete(
        {
          name: "score.repair.wave",
          subject: { pull_request_number: 9 },
          attributes: {
            wave: 2,
            open_findings: 5,
            diff_size: 240,
            head_sha: "abc123",
            prompt_version: "c6be2072b02c",
            conflicting: false,
            unresolved_threads: 3,
            failing_checks: 1,
            build_red: true,
          },
        },
        ctx,
      ),
    ]);
    for (const record of records) expect(recordViolations(record)).toEqual([]);
  });

  test("a finding record carries class, wave, resolution, and a repo-relative path", () => {
    const records = renderFindingTelemetry(
      9,
      {
        threadId: "PRRT_1",
        key: "o:src/a.ts:save",
        path: "src/a.ts",
        symbol: "save",
        origin: "o",
        author: "chatgpt-codex-connector",
        createdAt: TS,
        class: "regression-from-fix",
        wave: 1,
        fromLastFix: true,
        resolution: "open",
        resolvedBy: undefined,
      },
      ctx,
    );
    expect(records[0]?.attributes).toMatchObject({
      thread_id: "PRRT_1",
      fingerprint: "o:src/a.ts:save",
      class: "regression-from-fix",
      wave: 1,
      from_last_fix: true,
      resolution: "open",
      path: "src/a.ts",
      symbol: "save",
      author: "chatgpt-codex-connector",
    });
    expect(records[0]?.attributes).not.toHaveProperty("real");
    for (const record of records) expect(recordViolations(record)).toEqual([]);
  });

  test("a park record names the rule as an attribute and keeps the numbers in the body; a seen label emits nothing", () => {
    const parked = renderParkedTelemetry(
      {
        pullRequestNumber: 9,
        action: "EXHAUSTED",
        dryRun: false,
        target: "repair-exhausted",
        parked: {
          rule: "findings-flat",
          detail: "open findings 5 → 9 → 11 over the last three waves",
        },
      },
      ctx,
    );
    expect(parked).toEqual([
      complete(
        {
          name: "score.repair.parked",
          subject: { pull_request_number: 9 },
          attributes: { rule: "findings-flat" },
          body: "open findings 5 → 9 → 11 over the last three waves",
        },
        ctx,
      ),
    ]);
    expect(
      renderParkedTelemetry(
        { pullRequestNumber: 9, action: "EXHAUSTED", dryRun: false, target: "repair-exhausted" },
        ctx,
      ),
    ).toEqual([]);
  });

  test("an open-at-merge record carries the open and total counts", () => {
    expect(renderOpenAtMergeTelemetry(9, 2, 7, ctx)).toEqual([
      complete(
        {
          name: "score.repair.open_at_merge",
          subject: { pull_request_number: 9 },
          attributes: { open_findings: 2, total_findings: 7 },
        },
        ctx,
      ),
    ]);
  });
});
