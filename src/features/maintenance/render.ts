import type { MaintenanceTickResult } from "@/features/maintenance/service";
import type { LogLine } from "@/shared/log";

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
    } else {
      lines.push({
        level: "debug",
        text: `merged PR #${cleanup.pullRequestNumber} has no local worktree; nothing to clean`,
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

  // Quiet tick: nothing changed and nothing needs attention → no output at all.
  const cleaned = result.cleanup.filter(
    (cleanup) => cleanup.action === "CLEANED" || cleanup.action === "PLANNED",
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
