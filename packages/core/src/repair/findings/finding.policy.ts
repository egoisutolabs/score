import type {
  FindingClass,
  FindingRecord,
  FindingResolution,
  ReviewThreadObservation,
} from "@score/core/repair/findings/finding.interface";

/**
 * Declaration shapes across the languages Score's targets use. The nearest
 * declaration above the cited line wins, so a method beats its class. Not a
 * parser: a wrong symbol only weakens a key, it never breaks one.
 */
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|def|fn|struct|impl|trait|func(?:\s+\([^)]*\))?)\s+([A-Za-z_$][\w$]*)/;
// A binding is a declaration only when it holds a function or class; a local
// `const path = ...` inside a body is not the symbol a finding lives in.
const BINDING =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|class\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;
// A method line is matched in two anchored halves rather than one regex: the
// single pattern needed `.*` beside `\s*`, which is polynomial on a line of
// many spaces (CodeQL), and review-cited files are not ours to trust.
const METHOD_HEAD =
  /^\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*#?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>\s*)?\(/;
// After the last `)`: an optional return type, then the body's `{`. `=` is
// excluded so `foo(bar, (x) => {` reads as a call with a callback, not a method.
const METHOD_TAIL = /^\s*(?::[^{=]*)?\{\s*$/;
const NOT_A_METHOD: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "await",
  "else",
  "function",
  "constructor",
  "super",
  "new",
  "typeof",
  "expect",
  "test",
  "it",
  "describe",
]);

/** Name of the innermost declaration enclosing `line` (1-based) of `source`, if the heuristic finds one. */
export function enclosingSymbol(source: string, line: number): string | undefined {
  const lines = source.split("\n");
  for (let index = Math.min(line, lines.length) - 1; index >= 0; index -= 1) {
    const text = lines[index] ?? "";
    const declaration = DECLARATION.exec(text) ?? BINDING.exec(text);
    if (declaration) return declaration[1];
    const method = methodName(text);
    if (method !== undefined && !NOT_A_METHOD.has(method)) return method;
  }
  return undefined;
}

/** The method a line declares: `name(` with the line ending in `{`, or mid-parameter-list on `(` or `,`. */
function methodName(text: string): string | undefined {
  const head = METHOD_HEAD.exec(text);
  if (!head?.[1]) return undefined;
  const trimmed = text.trimEnd();
  if (trimmed.endsWith("(") || trimmed.endsWith(",")) return head[1];
  const close = text.lastIndexOf(")");
  if (close < head[0].length) return undefined;
  return METHOD_TAIL.test(text.slice(close + 1)) ? head[1] : undefined;
}

/** The identity two findings share when they are the same defect: where the code came from, and what it is in. */
export function findingKey(
  origin: string | undefined,
  thread: Pick<ReviewThreadObservation, "originalCommit" | "path" | "originalLine">,
  symbol: string | undefined,
): string {
  const commit = origin ?? thread.originalCommit ?? "unknown";
  return `${commit}:${thread.path}:${symbol ?? `L${thread.originalLine ?? 0}`}`;
}

// The baseline's heuristic (docs/review-loop-baseline.md), unanchored so a
// reviewer automation named around a marker (`review-claude`) counts as the
// baseline counted it; the scripts import this predicate, so the offline
// figures and the live ledger cannot drift apart.
const BOT_LOGIN = /\[bot\]$|codex|claude|coderabbit|copilot/i;

/**
 * The baseline counts a finding only when a bot reviewer opened the thread: a
 * human's inline comment is review the agent must still answer, but recording
 * it would inflate every share the telemetry is meant to re-measure against
 * that baseline. One notion of "bot" with resolutionOf below; an unnamed
 * author (deleted account) is unknown, not a bot.
 */
export function isReviewerBot(login: string | undefined): boolean {
  return login !== undefined && BOT_LOGIN.test(login);
}

/**
 * Who closed the thread decides whether it counts as closed. The thread's
 * author (a reviewer bot) or any bot pass closes it; anyone else is the agent
 * on the operator's token, or the operator — indistinguishable on GitHub, so
 * both read as a self-resolve the next review must confirm.
 */
export function resolutionOf(thread: ReviewThreadObservation): FindingResolution {
  if (!thread.isResolved) return "open";
  const by = thread.resolvedBy;
  if (by !== undefined && (by === thread.author || BOT_LOGIN.test(by))) return "reviewer-resolved";
  return "self-resolved";
}

export interface ClassificationInput {
  readonly key: string;
  readonly author: string | undefined;
  /** Waves the PR had received when the thread appeared. */
  readonly wave: number;
  /** True when blame says a fix commit introduced the cited line; undefined when blame could not say. */
  readonly originAfterFirstHead: boolean | undefined;
}

/**
 * Analysis §2.4, top to bottom. A finding blame cannot place is read as
 * missed-earlier: the benefit of the doubt goes to the agent, because the
 * convergence rules act on regressions and must not fire on a blame failure.
 */
export function classifyFinding(
  input: ClassificationInput,
  prior: readonly FindingRecord[],
): FindingClass {
  if (input.wave === 0) return "first-round";
  const sameKey = prior.filter((record) => record.key === input.key);
  if (sameKey.some((record) => record.resolution === "self-resolved")) return "fix-failed";
  if (sameKey.some((record) => record.resolution === "open" && record.author !== input.author)) {
    return "duplicate";
  }
  if (input.originAfterFirstHead === true) return "regression-from-fix";
  return "missed-earlier";
}
