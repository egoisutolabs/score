/**
 * The #78 mapping table: one row per cleanup action, dispatch decision/
 * reason, landing tag, and repair action existing at branch time, plus one
 * unknown-member row per phase. Expected records omit `dry_run` — the test
 * runs every row under both a real and a dry-run context and asserts the
 * flag itself.
 */

import type { CleanupResult } from "@score/core/cleanup/cleanup-result.interface";
import type { DispatchResult } from "@score/core/dispatch/dispatch-result.interface";
import type { LandingResult } from "@score/core/landing/change.interface";
import type { RepairResult } from "@score/core/repair/repair-result.interface";
import type { TelemetrySubject } from "@score/core/telemetry/telemetry.interface";

/** A record minus the context fields (v/ts/project/signal) and `dry_run`. */
export interface ExpectedRecord {
  readonly name: string;
  readonly subject: TelemetrySubject;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly body?: string;
}

export interface MappingRow<Input> {
  readonly label: string;
  readonly input: Input;
  readonly expected: readonly ExpectedRecord[];
}

// heldBy stays empty: a branch-name literal here would trip the
// identity-shape gate in boundary.test.ts (INVARIANTS.md rule 2).
const capacity = { active: 0, max: 2, heldBy: [], starved: false };
const emptyDispatch: DispatchResult = {
  started: [],
  planned: [],
  blocked: [],
  failed: [],
  capacity,
};

export const cleanupRows: readonly MappingRow<CleanupResult>[] = [
  {
    label: "merged NOT_FOUND",
    input: { pullRequestNumber: 11, action: "NOT_FOUND" },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { pull_request_number: 11 },
        attributes: { action: "NOT_FOUND" },
      },
    ],
  },
  {
    label: "merged BLOCKED_DIRTY",
    input: { pullRequestNumber: 12, action: "BLOCKED_DIRTY", message: "dirty worktree" },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { pull_request_number: 12 },
        attributes: { action: "BLOCKED_DIRTY" },
        body: "dirty worktree",
      },
    ],
  },
  {
    label: "merged PLANNED",
    input: { pullRequestNumber: 13, action: "PLANNED" },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { pull_request_number: 13 },
        attributes: { action: "PLANNED" },
      },
    ],
  },
  {
    label: "merged CLEANED",
    input: { pullRequestNumber: 14, action: "CLEANED" },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { pull_request_number: 14 },
        attributes: { action: "CLEANED" },
      },
    ],
  },
  {
    label: "stranded STRANDED_PINGED",
    input: { issueNumber: 21, action: "STRANDED_PINGED", dryRun: false },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { issue_number: 21 },
        attributes: { action: "STRANDED_PINGED" },
      },
    ],
  },
  {
    label: "stranded STRANDED_RECLAIMED",
    input: { issueNumber: 22, action: "STRANDED_RECLAIMED", dryRun: false },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { issue_number: 22 },
        attributes: { action: "STRANDED_RECLAIMED" },
      },
    ],
  },
  {
    label: "stranded STRANDED_DIRTY",
    input: { issueNumber: 23, action: "STRANDED_DIRTY", dryRun: false, message: "dirty worktree" },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { issue_number: 23 },
        attributes: { action: "STRANDED_DIRTY" },
        body: "dirty worktree",
      },
    ],
  },
  {
    label: "stranded STRANDED_RESPAWNED",
    input: {
      issueNumber: 24,
      action: "STRANDED_RESPAWNED",
      dryRun: false,
      message: "unfinished work",
    },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: { issue_number: 24 },
        attributes: { action: "STRANDED_RESPAWNED" },
        body: "unfinished work",
      },
    ],
  },
  {
    label: "auto-pull AUTO_PULL_REFUSED",
    input: { action: "AUTO_PULL_REFUSED", message: "primary checkout is not clean: a.txt" },
    expected: [
      {
        name: "score.cleanup.decision",
        subject: {},
        attributes: { action: "AUTO_PULL_REFUSED" },
        body: "primary checkout is not clean: a.txt",
      },
    ],
  },
  {
    label: "unknown action keeps the record",
    input: { pullRequestNumber: 15, action: "EVAPORATED" } as unknown as CleanupResult,
    expected: [
      {
        name: "score.cleanup.unknown",
        subject: { pull_request_number: 15 },
        attributes: { action: "EVAPORATED" },
      },
    ],
  },
];

export const dispatchRows: readonly MappingRow<DispatchResult>[] = [
  {
    label: "started",
    input: { ...emptyDispatch, started: [31] },
    expected: [
      {
        name: "score.dispatch.decision",
        subject: { issue_number: 31 },
        attributes: { decision: "started" },
      },
    ],
  },
  {
    label: "planned",
    input: { ...emptyDispatch, planned: [32] },
    expected: [
      {
        name: "score.dispatch.decision",
        subject: { issue_number: 32 },
        attributes: { decision: "planned" },
      },
    ],
  },
  {
    label: "blocked DEPENDENCY_INCOMPLETE",
    input: { ...emptyDispatch, blocked: [{ issueNumber: 33, reasons: ["DEPENDENCY_INCOMPLETE"] }] },
    expected: [
      {
        name: "score.dispatch.decision",
        subject: { issue_number: 33 },
        attributes: { decision: "blocked", reason: "DEPENDENCY_INCOMPLETE" },
      },
    ],
  },
  {
    label: "blocked ALREADY_IN_FLIGHT",
    input: { ...emptyDispatch, blocked: [{ issueNumber: 34, reasons: ["ALREADY_IN_FLIGHT"] }] },
    expected: [
      {
        name: "score.dispatch.decision",
        subject: { issue_number: 34 },
        attributes: { decision: "blocked", reason: "ALREADY_IN_FLIGHT" },
      },
    ],
  },
  {
    label: "blocked with two reasons yields one record per reason",
    input: {
      ...emptyDispatch,
      blocked: [{ issueNumber: 35, reasons: ["DEPENDENCY_INCOMPLETE", "ALREADY_IN_FLIGHT"] }],
    },
    expected: [
      {
        name: "score.dispatch.decision",
        subject: { issue_number: 35 },
        attributes: { decision: "blocked", reason: "DEPENDENCY_INCOMPLETE" },
      },
      {
        name: "score.dispatch.decision",
        subject: { issue_number: 35 },
        attributes: { decision: "blocked", reason: "ALREADY_IN_FLIGHT" },
      },
    ],
  },
  {
    label: "failed",
    input: { ...emptyDispatch, failed: [{ issueNumber: 36, message: "spawn refused" }] },
    expected: [
      {
        name: "score.dispatch.decision",
        subject: { issue_number: 36 },
        attributes: { decision: "failed" },
        body: "spawn refused",
      },
    ],
  },
  {
    label: "unknown block reason keeps the record",
    input: {
      ...emptyDispatch,
      blocked: [{ issueNumber: 37, reasons: ["MERCURY_RETROGRADE"] }],
    } as unknown as DispatchResult,
    expected: [
      {
        name: "score.dispatch.unknown",
        subject: { issue_number: 37 },
        attributes: { decision: "blocked", reason: "MERCURY_RETROGRADE" },
      },
    ],
  },
];

const landingTags = [
  "skipped",
  "would-merge",
  "conflict",
  "changes-requested",
  "checks-red",
  "checks-pending",
  "unresolved",
  "build-red",
  "soaking",
  "ready",
  "push-failed",
  "merged",
] as const;

export const landingRows: readonly MappingRow<LandingResult>[] = [
  ...landingTags.map((tag, index) => ({
    label: tag,
    input: { pullRequestNumber: 41 + index, tag, note: `note for ${tag}` },
    expected: [
      {
        name: "score.landing.decision",
        subject: { pull_request_number: 41 + index },
        attributes: { tag },
        body: `note for ${tag}`,
      },
    ],
  })),
  {
    label: "unknown tag keeps the record",
    input: {
      pullRequestNumber: 53,
      tag: "levitating",
      note: "novel state",
    } as unknown as LandingResult,
    expected: [
      {
        name: "score.landing.unknown",
        subject: { pull_request_number: 53 },
        attributes: { tag: "levitating" },
        body: "novel state",
      },
    ],
  },
];

const repairActions = ["NOT_NEEDED", "PINGED", "SPAWNED", "SKIPPED", "WORKING"] as const;

export const repairRows: readonly MappingRow<RepairResult>[] = [
  ...repairActions.map((action, index) => ({
    label: action,
    input: { pullRequestNumber: 61 + index, action, dryRun: false },
    expected: [
      {
        name: "score.repair.decision",
        subject: { pull_request_number: 61 + index },
        attributes: { action },
      },
    ],
  })),
  {
    label: "unknown action keeps the record",
    input: {
      pullRequestNumber: 66,
      action: "IMPROVISED",
      dryRun: false,
    } as unknown as RepairResult,
    expected: [
      {
        name: "score.repair.unknown",
        subject: { pull_request_number: 66 },
        attributes: { action: "IMPROVISED" },
      },
    ],
  },
];
