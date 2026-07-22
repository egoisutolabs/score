import type { LandingResult, LandingTag } from "@/features/landing/change";
import type { LogLine } from "@/shared/log";

const LANDING_ICONS: Record<LandingTag, string> = {
  merged: "✓",
  ready: "✓",
  soaking: "⏳",
  conflict: "⚠",
  "build-red": "✗",
  "checks-red": "✗",
  "checks-pending": "⏳",
  unresolved: "⏳",
  "changes-requested": "⚠",
  "would-merge": "·",
  skipped: "·",
};

const ATTENTION_TAGS: readonly LandingTag[] = [
  "conflict",
  "build-red",
  "checks-red",
  "changes-requested",
];

const STATE_CHANGE_TAGS = new Set<LandingTag>(["merged", "would-merge"]);

/**
 * Legacy babysit-prs surfaced a line per PR every tick; here only real state
 * changes (merged) are info, attention re-surfaces as warn, and steady
 * soaking/pending states stay at debug so a quiet tick prints nothing.
 */
export function renderLandingTick(results: readonly LandingResult[]): readonly LogLine[] {
  const lines: LogLine[] = [];
  const byTag = new Map<LandingTag, number[]>();
  for (const result of results) {
    const numbers = byTag.get(result.tag) ?? [];
    numbers.push(result.pullRequestNumber);
    byTag.set(result.tag, numbers);
    lines.push({
      level: STATE_CHANGE_TAGS.has(result.tag) ? "info" : "debug",
      text: `${LANDING_ICONS[result.tag]} #${result.pullRequestNumber} [${result.tag}] ${result.note}`,
    });
  }

  const attention = ATTENTION_TAGS.reduce((sum, tag) => sum + (byTag.get(tag)?.length ?? 0), 0);
  const stateChanges = [...STATE_CHANGE_TAGS].reduce(
    (sum, tag) => sum + (byTag.get(tag)?.length ?? 0),
    0,
  );
  const scoreboard = [...byTag.entries()].map(([tag, numbers]) => `${tag}=${numbers.length}`);
  if (scoreboard.length > 0) {
    lines.push({
      level: stateChanges + attention > 0 ? "info" : "debug",
      text: `tick: ${scoreboard.join("  ")}`,
    });
  }
  for (const tag of ATTENTION_TAGS) {
    const numbers = byTag.get(tag);
    if (numbers?.length) {
      lines.push({
        level: "warn",
        text: `needs attention (${tag}): ${numbers.map((n) => `#${n}`).join(" ")}`,
      });
    }
  }
  return lines;
}
