/**
 * One mapping from the daemon's decision vocabulary (landing tags, repair
 * actions, dispatch decisions, feed kinds) to the design file's color
 * vocabulary — so a word is colored identically wherever it appears.
 * Health hues carry state (green landed/ready, red failure, amber
 * needs-attention); cyan is agent activity, never alarm; everything
 * routine stays ink.
 */
export type Tone = "green" | "amber" | "red" | "cyan";

const RED = new Set(["push-failed", "conflict", "build-red", "checks-red", "blocked", "failed"]);
const AMBER = new Set(["changes-requested", "unresolved", "repair", "stranded"]);
const GREEN = new Set(["merged", "ready", "would-merge"]);
const CYAN = new Set(["dispatch", "started", "planned"]);

export function toneFor(word: string): Tone | undefined {
  if (RED.has(word)) return "red";
  if (AMBER.has(word)) return "amber";
  if (GREEN.has(word)) return "green";
  if (CYAN.has(word)) return "cyan";
  return undefined;
}

export const TONE_TEXT: Record<Tone, string> = {
  green: "text-health-green",
  amber: "text-health-amber",
  red: "text-health-red",
  cyan: "text-accent-cyan",
};
