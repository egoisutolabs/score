import { issueSessionSuffixPattern } from "@score/core/dispatch/dispatch.identity";
import type { ChangeCheck } from "@score/core/landing/change.interface";
import type { RepairExhaustion } from "@score/core/repair/wave.interface";

/**
 * The unmanaged template, legacy anchor quirk included — the shape and its
 * history live with issueSessionSuffixPattern in dispatch.identity.ts.
 */
export const DEFAULT_SESSION_SUFFIX = issueSessionSuffixPattern(undefined);

/**
 * A managed daemon matches exactly the sessions its own dispatch creates
 * (see sessionNameForIssue) — a bare or foreign-project session must never be
 * pinged. Identity's naming and this template are tied together by a test.
 */
export function sessionSuffixForNamespace(namespace: string | undefined): string {
  return issueSessionSuffixPattern(namespace);
}

export interface RepairDefects {
  readonly conflicting: boolean;
  readonly unresolvedThreads: number;
  readonly failingChecks: number;
  /**
   * Landing's build-red gate-failure tail (epic decision 11): the PR merges
   * textually but fails the merged-tree gate — invisible to GitHub CI, so
   * repair's own scan can never see it. Undefined = no verdict.
   */
  readonly buildRed?: string;
}

export function needsRepair(defects: RepairDefects): boolean {
  return (
    defects.conflicting ||
    defects.unresolvedThreads > 0 ||
    defects.failingChecks > 0 ||
    defects.buildRed !== undefined
  );
}

// The repair prompt itself lives with the other prompts; re-exported so the
// deep imports that predate the prompts folder keep working.
export { REPAIR_WAVE_STEPS, renderRepairPrompt } from "@score/core/prompts/repair.render";

/** Counts a head commit's checks the way landing's precondition does, without importing landing. */
export function countChecks(rollup: readonly ChangeCheck[]): {
  readonly failing: number;
  readonly pending: number;
} {
  let failing = 0;
  let pending = 0;
  for (const check of rollup) {
    if ("status" in check) {
      if (check.status !== "COMPLETED") pending += 1;
      else if (!SUCCESSFUL_CONCLUSIONS.has(check.conclusion ?? "")) failing += 1;
    } else if (check.state === "PENDING" || check.state === "EXPECTED") pending += 1;
    else if (check.state !== "SUCCESS") failing += 1;
  }
  return { failing, pending };
}

const SUCCESSFUL_CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** The label a PR carries once its round budget is spent; removing it grants a fresh budget. */
export const REPAIR_EXHAUSTED_LABEL = "repair-exhausted";

/**
 * Hidden first line of an exhaustion comment. Repair looks for it before
 * commenting, so a death between the comment and the label never posts twice.
 * It names the wave history it reports: a second exhaustion after a human
 * removed the label starts from an empty history, so its waves (and their
 * timestamps) differ and it earns its own comment instead of a bare label.
 */
export function exhaustionMarker(exhaustion: Pick<RepairExhaustion, "waves">): string {
  const last = exhaustion.waves.at(-1);
  return `<!-- score:repair-exhausted ${exhaustion.waves.length}@${last?.at ?? "none"} -->`;
}

// The wave and exhaustion shapes live in wave.interface.ts so the telemetry
// mapper can import them type-only; re-exported here for existing imports.
export type { RepairExhaustion, WaveRecord } from "@score/core/repair/wave.interface";

function describeDefects(defects: RepairDefects): string {
  const parts: string[] = [];
  if (defects.conflicting) parts.push("conflicts");
  if (defects.unresolvedThreads > 0)
    parts.push(`${defects.unresolvedThreads} unresolved thread(s)`);
  if (defects.failingChecks > 0) parts.push(`${defects.failingChecks} failing check(s)`);
  if (defects.buildRed !== undefined) parts.push("merged-tree build red");
  return parts.join(", ") || "none recorded";
}

/**
 * The single comment repair leaves when a PR's budget is spent. The wave
 * history is what a human needs to decide between finishing by hand, granting
 * another budget (remove the label), or closing — the daemon never closes.
 */
export function renderExhaustionComment(
  pullRequestNumber: number,
  exhaustion: RepairExhaustion,
): string {
  const lines = [
    exhaustionMarker(exhaustion),
    `Score stopped repairing PR #${pullRequestNumber} after ${exhaustion.waves.length} repair wave(s) (budget ${exhaustion.budget}). Rule: ${exhaustion.rule} — ${exhaustion.detail}.`,
    "",
    "| Wave | When | Head | Open findings | Diff | Sent to fix |",
    "| --- | --- | --- | --- | --- | --- |",
    ...exhaustion.waves.map(
      (wave, index) =>
        `| ${index + 1} | ${wave.at} | ${wave.headSha?.slice(0, 7) ?? "unknown"} | ${wave.openFindings} | ${wave.diffSize ?? "?"} | ${describeDefects(wave.defects)} |`,
    ),
    "",
    `No more pings until a human acts. Remove the \`${REPAIR_EXHAUSTED_LABEL}\` label to grant a fresh budget.`,
  ];
  return lines.join("\n");
}
