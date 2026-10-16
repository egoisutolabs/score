import { promptVersion } from "./prompt-version";

/**
 * The Code Review Rules section of AGENTS.md, verbatim. Both reviewers read
 * it (the Claude workflow at the base SHA, Codex from the checkout), so it
 * is a prompt in all but location; prompts.test.ts fails when it drifts.
 */
export const REVIEW_RULES = `## Code Review Rules

- Flag only real defects: wrong behavior, unhandled failure paths, races,
  state corruption, tests that would pass even if the behavior were wrong,
  and violations of the rules above (Node instead of Bun, Zod, policy not
  present in legacy/ for parity work, merged legacy boundaries).
- Structure and readability violations are real defects: fixtures outside
  \`fixtures/\`, new modules dumped outside a feature folder, a new folder
  without an \`index.ts\` front door, a front door left stale by the diff,
  and changed non-obvious logic left uncommented.
- Violations of \`INVARIANTS.md\` are real defects: a new multi-step
  external mutation without a rollback/reconcile path proven by a
  next-tick test, an identity shape (session name, branch prefix)
  derived outside \`dispatch.identity.ts\`, or a push to origin outside
  landing's tick.
- Do not comment on style, formatting, naming taste, or hypothetical
  future-proofing. If it works and is tested, it passes.
- Treat scope creep as a defect: changes unrelated to the PR's stated issue.
`;

export const REVIEW_RULES_VERSION = promptVersion(REVIEW_RULES);
