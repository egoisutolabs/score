import { readFile } from "node:fs/promises";

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
  renderLandingTelemetry,
  renderMaintenanceTickTelemetry,
  renderRepairTelemetry,
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
    const ctx: TelemetryRenderContext = { project: "score", ts: TS, dryRun };
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

test("a maintenance tick maps cleanup records before dispatch records", () => {
  const ctx: TelemetryRenderContext = { project: "score", ts: TS, dryRun: false };
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
  ]);
  for (const statement of phaseImports) {
    expect(statement.startsWith("import type")).toBe(true);
    const specifier = /from\s+"([^"]+)";$/.exec(statement)?.[1];
    expect(specifier !== undefined && allowed.has(specifier)).toBe(true);
  }
});
