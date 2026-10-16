import { promptVersion } from "./prompt-version";

/**
 * The one line dispatch hands a fresh session. Everything else is in TASK.md
 * (briefing.render.ts), so the harness sees the same instructions whether it
 * reads a prompt argument or a file.
 */
export function renderImplementationPrompt(): string {
  return "Read TASK.md and implement it end-to-end. Open a PR with Fixes in the body. Stop after reporting the PR URL.";
}

export const IMPLEMENTATION_PROMPT_VERSION = promptVersion(renderImplementationPrompt());
