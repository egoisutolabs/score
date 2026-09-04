import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import type { TaskBriefingWriter } from "@score/core/dispatch/task-briefing.interface";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import { VERIFY_COMMAND } from "@score/core/verify";
import type { AgentConfig } from "@score/shared/config/config.interface";

/**
 * Project-agnostic TASK.md briefing: the issue, the identity, and portable
 * policy. Repo facts are deliberately absent — the target repo's own
 * AGENTS.md/CLAUDE.md are the authority, and verification is the one Score
 * contract every project implements (`make verify`, see verify.ts) — because
 * this service briefs agents for any project the fleet cranks, not just Score.
 */
export class TaskBriefingService implements TaskBriefingWriter {
  render(issue: IssueObservation, identity: WorkIdentity, agent: AgentConfig): string {
    const priorComments = issue.comments.length
      ? `\n## Notes from Prior Work\n\n${issue.comments.map((comment) => `**@${comment.author?.login ?? "unknown"}**: ${comment.body.trim()}`).join("\n\n---\n\n")}\n`
      : "";

    // Claude sessions run on operator machines where the graphify and codex
    // skills may be installed; other harnesses have no skill surface, so the
    // workflow would be dead instructions there. Tool references stay
    // capability-conditional — this section names no repository facts.
    const workflow =
      agent.harness === "claude"
        ? `
## Workflow

Commit locally at each workflow boundary — after exploration notes, after
implementation, after each review-fix round — with concise messages. Local
commits are the liveness signal the fleet reads; a long quiet stretch with no
commits looks stranded. Push remains end-only, per Completion Instructions.

Work in this order:

1. **Explore before writing.** Map the code this task touches: similar
   patterns, the owning feature folder, its tests. Perform a
   **Defect Surface Analysis**: pinpoint the exact formulas, state
   transitions, and business rules being modified, list the core invariants
   (rules that must never be broken), and identify where the Defect
   Prevention classes below apply. Prefer read-only subagents for broad
   sweeps. If the graphify skill is available, query the
   repository's existing graph first (\`graphify-out/\` at the root); if the
   graph is missing or stale, index the repository again.
2. **Implement this TASK.md end-to-end.** Apply the **Defect Prevention**
   checklist below; preserve every invariant identified in your analysis.
3. **Review until clean.** If the codex review skill is available, run it
   over your diff and fix what it finds; repeat until it reports no new
   issues. An unavailable tool skips that tool only — the self-review in
   Completion Instructions is never skipped.
4. **Finish via Completion Instructions** (verification, self-review,
   commit, push, PR).
`
        : "";

    return `# Issue #${issue.number}: ${issue.title}

> GitHub: ${issue.url}
> Branch: \`${identity.branch}\`

---

${issue.body || ""}
${priorComments}
---

## Repo Context

Read \`AGENTS.md\` and \`CLAUDE.md\` at the repository root (and any nested ones
near the code you touch) before writing anything — they are the authority on
this repository's layout, conventions, and invariants. This briefing carries no
repository facts on purpose.

Keep PR scope limited to this issue. Add tests for behavioral changes.
${workflow}
## Required Verification

Run before committing, at the repository root:

\`\`\`sh
${VERIFY_COMMAND}
\`\`\`

The repository's Makefile owns what that target does. Never open a PR while
required verification fails: fix it, or — only for a pre-existing, unrelated
failure — document that failure in the PR body and still run the rest.

## Test Integrity

Write tests that would **fail** if the behavior is wrong. If you find yourself
writing a test that passes regardless of the implementation, that is a bug in
the test — fix the test or flag it. Ensure tests explicitly cover edge cases —
zero-scale, empty collections, nulls, and boundary values — for all modified
logic.

Do not paper over a bug to make tests green. If you discover a defect you
cannot properly fix within this issue's scope:

1. Open a \`triage\`-labeled issue for it. Nothing reads issue comments; only
   a \`triage\`-labeled issue reaches the backlog. Create the label first —
   an existing label is left untouched, so the already-exists error is
   ignored. Write the body to a file outside the repo with your file-writing
   tool — never through the shell, so backticks, \`$()\`, and quotes in the
   evidence stay literal — then file the issue from it:
   \`\`\`sh
   gh label create triage --description "Implementer-found defect awaiting triage" --color D93F0B 2>/dev/null || true
   gh issue create --label triage --title "<one-line defect statement>" --body-file /tmp/triage-${issue.number}.md
   \`\`\`
   The body must carry, in this order: what is wrong (observed vs expected);
   where (file, symbol, or user-visible behavior); evidence (how it was found,
   plus a repro or failing command if there is one); why it is out of scope for
   #${issue.number}; and the line \`Found while implementing #${issue.number}\`.
   Never add an \`epic:\` label, never assign, and never close that issue —
   triage owns it from there.
2. Open the PR anyway and reference the new issue in the PR body
   (\`Found #<M> during this work\`) so the operator can see it before merging.
3. Do not silently work around it or write a test that hides it.

## Defect Prevention

Address these specific classes to ensure a first-pass merge:

- **Error Paths**: Ensure isolated failure containment and resource cleanup.
- **Validation**: Enforce strict input format and schema validation.
- **Boundaries**: Validate all data crossing interface or system boundaries.
- **Numeric & Logic**: Handle NaN/Inf, overflows, and division-by-zero. Verify
  calculation correctness, rounding, and signage; check for integer division
  bugs and precision loss. Account for zero/empty inputs and all logical
  branches.
- **Concurrency**: Prevent race conditions and unsafe interleavings.

## Completion Instructions

1. Implement the issue end-to-end.
2. Run required verification.
3. Self-review the full diff hunk-by-hunk as if it were a stranger's PR,
   against this repository's own review rules (\`AGENTS.md\` Code Review Rules
   and \`INVARIANTS.md\` where present) and the **Defect Prevention** checklist.
   Perform a **Requirement Audit**: confirm every constraint and example in
   the issue body is satisfied. Fix everything you would flag in
   review. If the review changed anything, re-run required verification over
   the fixes before committing.
4. Commit with a concise message. Do not add Co-Authored-By or Claude-Session trailers.
5. Push the branch.
6. Open a PR with \`Fixes #${issue.number}\` in the body. Do not add a "Generated with Claude Code" footer or any session URLs.
7. Report the PR URL.
8. Stop after reporting the PR URL.

Do not run blocking PR watcher scripts from inside the implementation session. Review follow-up is handled by the operator or a separate continuation session.

Do not amend unrelated commits. Do not force-push unless explicitly asked.
`;
  }

  async write(issue: IssueObservation, identity: WorkIdentity, agent: AgentConfig): Promise<void> {
    writeFileSync(
      join(identity.worktreePath, "TASK.md"),
      this.render(issue, identity, agent),
      "utf8",
    );
  }
}
