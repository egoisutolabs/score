import { createWorkIdentity } from "@score/core/dispatch/dispatch.identity";
import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import { TaskBriefingService } from "@score/core/dispatch/task-briefing.service";
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

test("self-review is ordered after verification and before commit", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity);
  const instructions = markdown.slice(markdown.indexOf("## Completion Instructions"));

  const verify = instructions.indexOf("Run required verification.");
  const selfReview = instructions.indexOf("Self-review the full diff");
  const commit = instructions.indexOf("Commit with a concise message");

  expect(verify).toBeGreaterThan(-1);
  expect(selfReview).toBeGreaterThan(verify);
  expect(commit).toBeGreaterThan(selfReview);

  // The review standard is the target repo's own rules, not Score's.
  expect(instructions).toContain("stranger's PR");
  expect(instructions).toContain("`AGENTS.md` Code Review Rules");
  expect(instructions).toContain("`INVARIANTS.md` where present");
});

test("briefing forbids opening a PR while required verification fails", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity);
  // Collapse the template's hard line wraps so prose can be matched as written.
  const unwrapped = markdown.replace(/\s+/g, " ");

  expect(unwrapped).toContain("Never open a PR while required verification fails");
  // The only escape hatch is a documented pre-existing, unrelated failure.
  expect(unwrapped).toContain("pre-existing, unrelated failure");
});
