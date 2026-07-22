import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { IssueObservation } from "@/features/dispatch/issue";
import type { TaskBriefingWriter } from "@/features/dispatch/task-briefing-port";
import type { WorkIdentity } from "@/features/dispatch/work";

/** Active legacy Claude TASK.md template, retained verbatim as runtime behavior. */
export class TaskBriefingService implements TaskBriefingWriter {
  render(issue: IssueObservation, identity: WorkIdentity): string {
    const priorComments = issue.comments.length
      ? `\n## Notes from Prior Work\n\n${issue.comments
          .map((comment) => `**@${comment.author?.login ?? "unknown"}**: ${comment.body.trim()}`)
          .join("\n\n---\n\n")}\n`
      : "";

    return `# Issue #${issue.number}: ${issue.title}

> GitHub: ${issue.url}
> Branch: \`${identity.branch}\`
> Repo: \`score\`

---

${issue.body || ""}
${priorComments}
---

## Repo Context

Score is a local daemon that turns issue-tracker issues into shipped work, plus a
dashboard and two reusable libraries. It is a **Bun/TypeScript** monorepo — not
Node, not Go.

Core areas:

- \`daemon/\` - Bun/TypeScript orchestrator: \`server\` (HTTP API on :7331) + \`worker\`
  (the poll loop), with MongoDB as the state store. Start at \`daemon/ARCHITECTURE.md\`.
- \`dashboard/\` - Next.js UI; proxies \`/api/*\` to the daemon.
- \`skills/\` - generic planning/operator skills (each a \`SKILL.md\`).
- \`agents/\` - generic codebase-exploration subagents.
- \`.claude/\` - Claude Code discovery layer (symlinks to \`agents/\` and \`skills/\`).

Required conventions:

- Use **Bun**, never Node: \`bun <file>\`, \`bun test\`, \`bun install\`, \`bun run <script>\`.
  See \`daemon/CLAUDE.md\`.
- Preserve the invariants documented in the root \`CLAUDE.md\` and \`daemon/CLAUDE.md\`.
- \`agents/\` and \`skills/\` are canonical and project-agnostic — do not duplicate them
  or bake project-specific assumptions into them.
- Add tests for behavioral changes.
- Keep PR scope limited to this issue.

## Required Verification

Run the checks for the package you changed before committing.

For \`daemon/\` changes (most issues):

\`\`\`sh
cd daemon
bun install                  # only if dependencies changed
docker compose up -d mongo   # bun test needs MongoDB on :27017
bun run check                # tsc --noEmit
bun test
\`\`\`

For \`dashboard/\` changes:

\`\`\`sh
cd dashboard
bun install                  # only if dependencies changed
bun run build
\`\`\`

If a check reports a pre-existing, unrelated failure, document it in the PR body and
still run the rest.

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
3. Commit with a concise message. Do not add Co-Authored-By or Claude-Session trailers.
4. Push the branch.
5. Open a PR with \`Fixes #${issue.number}\` in the body. Do not add a "Generated with Claude Code" footer or any session URLs.
6. Report the PR URL.
7. Stop after reporting the PR URL.

Do not run blocking PR watcher scripts from inside the implementation session. Review follow-up is handled by the operator or a separate continuation session.

Do not amend unrelated commits. Do not force-push unless explicitly asked.
`;
  }

  async write(issue: IssueObservation, identity: WorkIdentity): Promise<void> {
    writeFileSync(join(identity.worktreePath, "TASK.md"), this.render(issue, identity), "utf8");
  }
}
