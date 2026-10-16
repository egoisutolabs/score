import { issueSessionSuffixPattern } from "@score/core/dispatch/dispatch.identity";
import type { ChangeCheck } from "@score/core/landing/change.interface";
import { VERIFY_COMMAND } from "@score/core/verify";

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

/**
 * The seven steps of one repair wave, in protocol order (review-loop analysis
 * §2.1). Exported so the contract test can assert the rendered prompt names
 * each step in this order rather than merely containing the words.
 */
export const REPAIR_WAVE_STEPS = [
  "TRIAGE",
  "CLASS",
  "FAILURE PATHS",
  "DELETE FIRST",
  "TEST FIRST",
  "VERIFY",
  "ONE COMMIT",
] as const;

/**
 * Repair prompt: one wave per review round, merge authority withheld.
 *
 * Why a wave and not "fix each thread": across the 14 score PRs with review
 * threads, 59% of threads were opened in round two or later and 75% cited a
 * line added after the first commit (docs/review-loop-baseline.md). The old
 * prompt made the agent patch the cited example; this one makes it triage,
 * name the class, sweep the diff, prefer deletion, and test before it pushes.
 *
 * Why one line: TmuxService.ping delivers the message with send-keys followed
 * by Enter, so a newline would submit a partial prompt. Keep every edit on
 * one line until ping delivers through a file like startRepair does.
 *
 * Why the agent still resolves FIX threads: landing's precondition counts
 * unresolved threads and Codex never resolves its own, so until the per-PR
 * ledger (analysis §2.4) replaces that count, a thread the agent fixed and
 * verified must be resolved by the agent or the PR never lands. A DECLINE is
 * never resolved — the reviewer or a human closes it.
 */
export function renderRepairPrompt(pullRequestNumber: number, buildRed?: string): string {
  const gateNote =
    buildRed === undefined
      ? ""
      : ` Note: this PR also fails the local merged-tree build gate, which GitHub CI cannot see — after merging origin/main, fix this failure too: ${buildRed}.`;
  return (
    `Follow-up on your PR #${pullRequestNumber}: do one repair wave, then stop. ` +
    `Setup: git fetch origin && merge origin/main into this branch, resolving every conflict per the code's intent; ` +
    `check failing CI with \`gh pr checks ${pullRequestNumber}\` and \`gh run view --log-failed\`. ` +
    `Then the wave, in order: ` +
    `(1) TRIAGE — list every unresolved review thread (gh api graphql reviewThreads where isResolved is false) and mark each FIX or DECLINE with a one-line reason; ` +
    `decline a finding that is wrong, outside this PR's issue, or asks for a mechanism the issue does not need, and reply in that thread with the reason; ` +
    `a finding in code this PR added is always FIX or DECLINE, never a triage issue. ` +
    `(2) CLASS — for each FIX name the defect class (unhandled failure path, race, boundary, test that passes when behavior is wrong, ...) and sweep the full PR diff for every other instance of that class; fix them in this same wave. ` +
    `(3) FAILURE PATHS — for each mutation this PR changes (file, process, git, network), list what happens when it fails midway and make sure each path is handled or covered by a test. ` +
    `(4) DELETE FIRST — before adding a lock, retry, flag, or timeout, try removing the thing that needs it; a fix that shrinks the diff beats one that grows it. ` +
    `(5) TEST FIRST — for each FIX write a test that fails on the current tree, then make it pass. ` +
    `(6) VERIFY — run ${VERIFY_COMMAND} at the repository root; do not push while it fails. ` +
    `(7) ONE COMMIT — commit the whole wave once and push once; reply in each FIX thread naming that commit, then resolve only those threads; never resolve a DECLINE. ` +
    `Do NOT merge the PR — report FIX/DECLINE per thread and the commit, then stop.${gateNote}`
  );
}

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
 * Hidden first line of the one exhaustion comment. Repair looks for it before
 * commenting, so a death between the comment and the label never posts twice.
 */
export const REPAIR_EXHAUSTED_MARKER = "<!-- score:repair-exhausted -->";

/** One repair wave as the ledger recorded it: what the agent was sent to fix, and when. */
export interface WaveRecord {
  readonly at: string;
  readonly tick: number;
  readonly headSha: string | undefined;
  readonly defects: RepairDefects;
}

export interface RepairExhaustion {
  readonly budget: number;
  readonly waves: readonly WaveRecord[];
}

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
    REPAIR_EXHAUSTED_MARKER,
    `Score stopped repairing PR #${pullRequestNumber}: ${exhaustion.waves.length} repair wave(s) used the budget of ${exhaustion.budget} without the PR landing.`,
    "",
    "| Wave | When | Head | Sent to fix |",
    "| --- | --- | --- | --- |",
    ...exhaustion.waves.map(
      (wave, index) =>
        `| ${index + 1} | ${wave.at} | ${wave.headSha?.slice(0, 7) ?? "unknown"} | ${describeDefects(wave.defects)} |`,
    ),
    "",
    `No more pings until a human acts. Remove the \`${REPAIR_EXHAUSTED_LABEL}\` label to grant a fresh budget.`,
  ];
  return lines.join("\n");
}
