import { createWorkIdentity } from "@score/core/dispatch/identity";
import type { IssueObservation } from "@score/core/dispatch/issue";
import { TaskBriefingService } from "@score/core/dispatch/task-briefing";
import { expect, test } from "vitest";

function issue(): IssueObservation {
  return {
    number: 9,
    title: "Port the legacy task",
    body: "## Objective\nPreserve behavior.",
    labels: [{ name: "epic:v0" }],
    state: "OPEN",
    url: "https://github.com/example/score/issues/9",
    comments: [{ author: { login: "operator" }, body: "keep parity" }],
  };
}

test("briefing carries the issue, prior comments, and the portable policy contract", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity);

  expect(markdown).toContain("# Issue #9: Port the legacy task");
  expect(markdown).toContain("## Notes from Prior Work");
  expect(markdown).toContain("**@operator**: keep parity");
  expect(markdown).toContain("Do not run blocking PR watcher scripts");
  expect(markdown).toContain("Do not amend unrelated commits. Do not force-push");
});

test("briefing is project-agnostic: configured verification, repo facts delegated", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity);

  // Verification is exactly what the project configured — nothing invented.
  expect(markdown).toContain("make verify");
  // Repo truth is delegated to the checkout's own instruction files.
  expect(markdown).toContain("AGENTS.md");
  // The legacy Score-specific repo map must never resurface for other projects.
  expect(markdown).not.toContain("cd daemon");
  expect(markdown).not.toContain("MongoDB");
  expect(markdown).not.toContain("Repo: `score`");
});
