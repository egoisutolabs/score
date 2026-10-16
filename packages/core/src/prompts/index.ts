/**
 * Prompts: every piece of text Score puts in front of a model, one render
 * module each, versioned by content hash. The briefing, the implementation
 * line, the repair wave, and the stranded ladder are rendered here and
 * called from their features; the reviewer prompt and the AGENTS.md review
 * rules are copies pinned to their source files by prompts.test.ts. Owns no
 * decision about when a prompt is sent.
 */

export * from "./briefing.render";
export * from "./implementation.render";
export * from "./prompt-version";
export * from "./repair.render";
export * from "./review-rules.render";
export * from "./reviewer.render";
export * from "./stranded.render";
