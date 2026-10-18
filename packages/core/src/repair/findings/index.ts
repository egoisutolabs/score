/**
 * Findings: review threads keyed by blame origin, file, and enclosing symbol,
 * classified against the PR's history (fix-failed, duplicate,
 * regression-from-fix, missed-earlier). Owns no storage — the daemon's
 * RepairLedger holds the records — and never decides what repair does next.
 */

export * from "./finding.interface";
export * from "./finding.policy";
export * from "./finding-tracker.service";
