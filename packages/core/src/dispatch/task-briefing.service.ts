import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import type { TaskBriefingWriter } from "@score/core/dispatch/task-briefing.interface";
import type { WorkIdentity } from "@score/core/dispatch/work.interface";
import { VERIFY_COMMAND } from "@score/core/verify";

/**
 * Project-agnostic TASK.md briefing: the issue, the identity, and portable
 * policy. Repo facts are deliberately absent — the target repo's own
 * AGENTS.md/CLAUDE.md are the authority, and verification is the one Score
 * contract every project implements (`make verify`, see verify.ts) — because
 * this service briefs agents for any project the fleet cranks, not just Score.
 */
export class TaskBriefingService implements TaskBriefingWriter {
  render(issue: IssueObservation, identity: WorkIdentity): string {
    const priorComments = issue.comments.length
      ? `\n## Notes from Prior Work\n\n${issue.comments.map((comment) => `**@${comment.author?.login ?? "unknown"}**: ${comment.body.trim()}`).join("\n\n---\n\n")}\n`
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
the test — fix the test or flag it.

Do not paper over a bug to make tests green. If you discover a defect you
cannot properly fix within this issue's scope:

1. Post a comment on this issue:
   \`\`\`sh
   gh issue comment ${issue.number} --body "Found bug: <description of what is wrong and why it is out of scope>"
   \`\`\`
2. Open the PR anyway with the comment reference in the PR body so the operator
   can see it before merging.
3. Do not silently work around it or write a test that hides it.

## Completion Instructions

1. Implement the issue end-to-end.
2. Run required verification.
3. Self-review the full diff hunk-by-hunk as if it were a stranger's PR,
   against this repository's own review rules (\`AGENTS.md\` Code Review Rules
   and \`INVARIANTS.md\` where present). Fix everything you would flag in
   review before committing.
4. Commit with a concise message. Do not add Co-Authored-By or Claude-Session trailers.
5. Push the branch.
6. Open a PR with \`Fixes #${issue.number}\` in the body. Do not add a "Generated with Claude Code" footer or any session URLs.
7. Report the PR URL.
8. Stop after reporting the PR URL.

Do not run blocking PR watcher scripts from inside the implementation session. Review follow-up is handled by the operator or a separate continuation session.

Do not amend unrelated commits. Do not force-push unless explicitly asked.
`;
  }

  async write(issue: IssueObservation, identity: WorkIdentity): Promise<void> {
    writeFileSync(join(identity.worktreePath, "TASK.md"), this.render(issue, identity), "utf8");
  }
}
