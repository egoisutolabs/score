/**
 * One mapping from the daemon's decision vocabulary (landing tags, repair
 * actions, dispatch decisions, feed kinds) to the console's health tones —
 * so a word is colored identically wherever it appears. Hue stays reserved:
 * green for landed/ready, red for failure, amber for needs-attention,
 * undefined for routine.
 */
export type Tone = "green" | "amber" | "red";

const RED = new Set(["push-failed", "conflict", "build-red", "checks-red", "blocked", "failed"]);
const AMBER = new Set(["changes-requested", "unresolved", "repair", "stranded"]);
const GREEN = new Set(["merged", "ready", "would-merge"]);

export function toneFor(word: string): Tone | undefined {
  if (RED.has(word)) return "red";
  if (AMBER.has(word)) return "amber";
  if (GREEN.has(word)) return "green";
  return undefined;
}

export const TONE_TEXT: Record<Tone, string> = {
  green: "text-health-green",
  amber: "text-health-amber",
  red: "text-health-red",
};
