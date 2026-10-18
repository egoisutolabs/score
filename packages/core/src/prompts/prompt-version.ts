import { createHash } from "node:crypto";

/**
 * A prompt's version is a hash of its content, never a hand-bumped number:
 * any edit changes it, nothing else does, and telemetry segmented by it
 * compares like with like. Twelve hex characters are plenty for the handful
 * of prompts a fleet ever runs.
 */
export function promptVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
