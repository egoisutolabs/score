import type { MaintenanceTickResult } from "@score/core/maintenance/maintenance.service";
import type { LogLine } from "@score/shared/log";

export function renderMaintenanceTick(result: MaintenanceTickResult): readonly LogLine[] {
  const lines: LogLine[] = [];
  for (const cleanup of result.cleanup) {
    if (cleanup.action === "CLEANED") {
      lines.push({ level: "info", text: `✓ cleaned merged PR #${cleanup.pullRequestNumber}` });
    } else if (cleanup.action === "PLANNED") {
      lines.push({
        level: "info",
        text: `· (dry-run) would clean merged PR #${cleanup.pullRequestNumber}`,
      });
    } else if (cleanup.action === "BLOCKED_DIRTY") {
      lines.push({
        level: "warn",
        text: `⚠ skipping cleanup for PR #${cleanup.pullRequestNumber}: ${cleanup.message ?? "dirty worktree"}`,
      });
    } else if (cleanup.action === "NOT_FOUND") {
      lines.push({
        level: "debug",
        text: `merged PR #${cleanup.pullRequestNumber} has no local worktree; nothing to clean`,
      });
    } else if (cleanup.action === "STRANDED_PINGED") {
      lines.push({
        level: "warn",
        text: `⚠ ${cleanup.dryRun ? "(dry-run) would ping" : "pinged"} stranded issue #${cleanup.issueNumber}: worktree has no PR and no new commits`,
      });
    } else if (cleanup.action === "STRANDED_RECLAIMED") {
      lines.push({
        level: "info",
        text: `${cleanup.dryRun ? "· (dry-run) would reclaim" : "✓ reclaimed"} stranded issue #${cleanup.issueNumber} (no PR, no commits, agent silent)`,
      });
    } else if (cleanup.action === "STRANDED_DIRTY") {
      lines.push({
        level: "warn",
        text: `⚠ stranded issue #${cleanup.issueNumber} not reclaimed: ${cleanup.message ?? "dirty worktree"}`,
      });
    } else if (cleanup.action === "AUTO_PULL_REFUSED") {
      // Loud on every pass (#91): a silent refusal once ran the fleet 30
      // commits stale for four hours.
      lines.push({
        level: "warn",
        text: `⚠ auto-pull of the default branch refused: ${cleanup.message}`,
      });
    } else if (cleanup.action === "STRANDED_RESPAWNED") {
      lines.push({
        level: "warn",
        text: `⚠ ${cleanup.dryRun ? "(dry-run) would respawn" : "respawned"} agent for stranded issue #${cleanup.issueNumber}: ${cleanup.message ?? "worktree holds unfinished work"}`,
      });
    }
  }
  for (const issue of result.dispatch.started) {
    lines.push({ level: "info", text: `✓ started issue #${issue}` });
  }
  for (const issue of result.dispatch.planned) {
    lines.push({ level: "info", text: `· (dry-run) would start issue #${issue}` });
  }
  for (const block of result.dispatch.blocked) {
    lines.push({
      level: "debug",
      text: `#${block.issueNumber} blocked: ${block.reasons.join(", ")}`,
    });
  }
  for (const failure of result.dispatch.failed) {
    lines.push({
      level: "warn",
      text: `✗ failed to start #${failure.issueNumber}: ${failure.message}`,
    });
  }
  // The zero-slot tick used to exit before producing a single line (#65). Warn,
  // not debug: a slot holder that never clears is exactly the stale-worktree
  // drift that stayed invisible for two days.
  if (result.dispatch.capacity.starved) {
    const { active, max, heldBy } = result.dispatch.capacity;
    lines.push({
      level: "warn",
      text: `⚠ dispatch at capacity (${active}/${max}): no slot free for eligible issues — held by ${heldBy.join(", ")}`,
    });
  }

  // Quiet tick: nothing changed and nothing needs attention → no output at all.
  const cleaned = result.cleanup.filter(
    (cleanup) =>
      cleanup.action === "CLEANED" ||
      cleanup.action === "PLANNED" ||
      cleanup.action === "STRANDED_RECLAIMED",
  ).length;
  const started = result.dispatch.started.length + result.dispatch.planned.length;
  const failed = result.dispatch.failed.length;
  if (cleaned + started + failed > 0) {
    lines.push({
      level: "info",
      text: `tick: cleaned=${cleaned} started=${started} failed=${failed}`,
    });
  }
  return lines;
}
