import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkIdentity } from "@score/core/dispatch/dispatch.identity";
import type { IssueObservation } from "@score/core/dispatch/issue.interface";
import { TaskBriefingService } from "@score/core/dispatch/task-briefing.service";
import type { AgentConfig } from "@score/shared/config/config.interface";
import { expect, test } from "vitest";

const claude: AgentConfig = { harness: "claude", model: "claude-fable-5" };
const opencode: AgentConfig = { harness: "opencode", model: "provider/model" };

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
  const markdown = new TaskBriefingService().render(issue(), identity, claude);

  expect(markdown).toContain("# Issue #9: Port the legacy task");
  expect(markdown).toContain("## Notes from Prior Work");
  expect(markdown).toContain("**@operator**: keep parity");
  expect(markdown).toContain("Do not run blocking PR watcher scripts");
  expect(markdown).toContain("Do not amend unrelated commits. Do not force-push");
});

test("briefing is project-agnostic: configured verification, repo facts delegated", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity, claude);

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
  const markdown = new TaskBriefingService().render(issue(), identity, claude);
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
  // Review-driven fixes cannot land unverified: the step demands re-verification.
  const unwrapped = instructions.replace(/\s+/g, " ");
  expect(unwrapped).toContain(
    "If the review changed anything, re-run required verification over the fixes before committing.",
  );
});

test("claude briefings carry the ordered workflow; tool steps are capability-conditional", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity, claude);
  const workflow = markdown.slice(
    markdown.indexOf("## Workflow"),
    markdown.indexOf("## Required Verification"),
  );

  const explore = workflow.indexOf("Explore before writing.");
  const implement = workflow.indexOf("Implement this TASK.md end-to-end.");
  const review = workflow.indexOf("Review until clean.");
  const finish = workflow.indexOf("Finish via Completion Instructions");
  expect(explore).toBeGreaterThan(-1);
  expect(implement).toBeGreaterThan(explore);
  expect(review).toBeGreaterThan(implement);
  expect(finish).toBeGreaterThan(review);

  // Tools are offered, never assumed — and their absence cannot waive review.
  expect(workflow).toContain("If the graphify skill is available");
  expect(workflow).toContain("If the codex review skill is available");
  const unwrapped = workflow.replace(/\s+/g, " ");
  expect(unwrapped).toContain(
    "An unavailable tool skips that tool only — the self-review in Completion Instructions is never skipped.",
  );
});

test("commit-as-you-go rule sits inside the workflow section, before the push step", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity, claude);
  const workflow = markdown.slice(
    markdown.indexOf("## Workflow"),
    markdown.indexOf("## Required Verification"),
  );

  const unwrapped = workflow.replace(/\s+/g, " ");
  const rule = unwrapped.indexOf(
    "Commit locally at each workflow boundary — after exploration notes, after implementation, after each review-fix round — with concise messages.",
  );
  const push = unwrapped.indexOf("push");
  expect(rule).toBeGreaterThan(-1);
  expect(push).toBeGreaterThan(rule);
  // Push stays end-only — the rule defers to Completion Instructions, not a new push cadence.
  expect(unwrapped).toContain("Push remains end-only, per Completion Instructions.");
});

test("non-claude briefings carry no workflow section", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity, opencode);

  expect(markdown).not.toContain("## Workflow");
  expect(markdown).not.toContain("graphify");
  expect(markdown).not.toContain("codex");
  // The rest of the contract is unchanged for other harnesses.
  expect(markdown).toContain("## Completion Instructions");
  expect(markdown).toContain("Self-review the full diff");
});

test("defect prevention checklist is harness-agnostic and wired into analysis and self-review", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  for (const agent of [claude, opencode]) {
    const markdown = new TaskBriefingService().render(issue(), identity, agent);
    const section = markdown.slice(
      markdown.indexOf("## Defect Prevention"),
      markdown.indexOf("## Completion Instructions"),
    );
    // The classes reviewers actually flag, each present as an explicit target.
    for (const cls of [
      "Error Paths",
      "Validation",
      "Boundaries",
      "Numeric & Logic",
      "Concurrency",
    ]) {
      expect(section).toContain(`**${cls}**`);
    }
    // Self-review audits the diff against the checklist, not just repo rules.
    const instructions = markdown.slice(markdown.indexOf("## Completion Instructions"));
    expect(instructions).toContain("**Defect Prevention** checklist");
  }
  // The claude workflow's analysis step names the same checklist.
  const markdown = new TaskBriefingService().render(issue(), identity, claude);
  expect(markdown).toContain("Defect Surface Analysis");
});

test("self-review demands a requirement audit against the issue body", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity, claude);
  const instructions = markdown.slice(markdown.indexOf("## Completion Instructions"));
  const unwrapped = instructions.replace(/\s+/g, " ");

  const audit = unwrapped.indexOf(
    "Perform a **Requirement Audit**: confirm every constraint and example in the issue body is satisfied.",
  );
  const commit = unwrapped.indexOf("Commit with a concise message");
  expect(audit).toBeGreaterThan(-1);
  expect(commit).toBeGreaterThan(audit);
});

test("test integrity requires explicit edge-case coverage", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity, claude);
  const unwrapped = markdown.replace(/\s+/g, " ");

  expect(unwrapped).toContain(
    "Ensure tests explicitly cover edge cases — zero-scale, empty collections, nulls, and boundary values — for all modified logic.",
  );
});

test("briefing forbids opening a PR while required verification fails", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const markdown = new TaskBriefingService().render(issue(), identity, claude);
  // Collapse the template's hard line wraps so prose can be matched as written.
  const unwrapped = markdown.replace(/\s+/g, " ");

  // The full clause: the prohibition plus its sole, explicitly-scoped escape
  // hatch — weakening either must fail this test.
  expect(unwrapped).toContain(
    "Never open a PR while required verification fails: fix it, or — only for a pre-existing, unrelated failure — document that failure in the PR body and still run the rest.",
  );
});

test("out-of-scope defects are filed as triage-labeled issues, never as comments", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const md = new TaskBriefingService().render(issue(), identity, claude);
  expect(md).toContain(
    'gh label create triage --description "Implementer-found defect awaiting triage" --color D93F0B 2>/dev/null || true',
  );
  expect(md).not.toContain("--force");
  expect(md).toContain(
    'gh issue create --label triage --title "$(cat /tmp/triage-issue-9-port-the-legacy-task.title)" --body-file /tmp/triage-issue-9-port-the-legacy-task.md',
  );
  // Neither title nor body may pass through shell quoting: no inline --body, no heredoc.
  expect(md).not.toContain('--body "');
  expect(md).not.toContain("<<");
  expect(md).toContain("Found while implementing #9");
  expect(md).not.toContain("gh issue comment");
});

test("the emitted filing block runs verbatim and delivers a hostile title and body literally", () => {
  const identity = createWorkIdentity("/worktrees", issue());
  const md = new TaskBriefingService().render(issue(), identity, claude);
  const block = /```sh\n([ \t]*gh label create triage[\s\S]*?)```/.exec(md)?.[1];
  expect(block).toBeDefined();
  // Every character class the shell would expand or mangle if the text were re-parsed.
  const title = "`Foo` breaks on $(bar) \"quoted\" 'single'";
  const body = "observed `x` vs $(expected) \"quoted\" 'single'\nFound while implementing #9";
  const dir = mkdtempSync(join(tmpdir(), "briefing-gh-"));
  writeFileSync(join(dir, "triage-9.title"), `${title}\n`);
  writeFileSync(join(dir, "triage-9.md"), body);
  const log = join(dir, "log");
  // Stub gh records argv one per line; a mangled title or body shows up as different argv.
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\n`, { mode: 0o755 });
  const scriptPath = join(dir, "file.sh");
  writeFileSync(scriptPath, (block as string).replaceAll(`/tmp/triage-${identity.branch}`, join(dir, "triage-9")));
  const run = spawnSync("sh", ["-e", scriptPath], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
  const argv = readFileSync(log, "utf8").split("\n");
  expect(argv).toContain(title);
  expect(argv[argv.indexOf("--label") + 1]).toBe("triage");
  expect(readFileSync(argv[argv.indexOf("--body-file") + 1] as string, "utf8")).toBe(body);
});
