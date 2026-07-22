import { expect, test } from "vitest";

import { createWorkIdentity } from "@/features/dispatch/identity";
import type { IssueObservation } from "@/features/dispatch/issue";
import { TaskBriefingService } from "@/features/dispatch/task-briefing";

test("briefing preserves the active legacy Claude task contract and prior comments", () => {
  const issue: IssueObservation = {
    number: 9,
    title: "Port the legacy task",
    body: "## Objective\nPreserve behavior.",
    labels: [{ name: "epic:v0" }],
    state: "OPEN",
    url: "https://github.com/example/score/issues/9",
    comments: [{ author: { login: "operator" }, body: "keep parity" }],
  };
  const identity = createWorkIdentity("/worktrees", issue);
  const markdown = new TaskBriefingService().render(issue, identity);

  expect(markdown).toContain("## Notes from Prior Work");
  expect(markdown).toContain("**@operator**: keep parity");
  expect(markdown).toContain("cd daemon");
  expect(markdown).toContain("cd dashboard");
  expect(markdown).toContain("Do not run blocking PR watcher scripts");
  expect(markdown).toContain("Do not amend unrelated commits. Do not force-push");
});
