import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import { GitHubService } from "@score/tracker/github.service";
import { expect, test } from "vitest";

class RecordingRunner implements CommandRunner {
  readonly commands: string[][] = [];
  responses: string[] = [];

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.commands.push([...command]);
    return {
      command,
      cwd: options.cwd,
      exitCode: 0,
      stdout: this.responses.shift() ?? "[]",
      stderr: "",
      timedOut: false,
      dryRun: false,
    };
  }
}

test("dispatch and cleanup use narrow legacy GitHub observations", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify({ number: 2, state: "CLOSED", stateReason: "COMPLETED" }),
    JSON.stringify([{ number: 5, headRefName: "issue-2-old-slug" }]),
    JSON.stringify([{ number: 5, headRefName: "issue-2-old-slug", mergedAt: "now" }]),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  await github.observeDependency(2);
  await github.observeOpenChangeHeads();
  await github.observeMergedOwnedChanges();

  expect(runner.commands.map((command) => command.at(-1))).toEqual([
    "number,state,stateReason",
    "number,headRefName",
    "number,headRefName,mergedAt",
  ]);
});

test("history observes merged pull requests regardless of Score branch identity", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify([
      {
        number: 103,
        title: "Port API to Express",
        headRefName: "feature/next-to-express",
        mergedAt: "2026-08-18T01:25:50Z",
      },
    ]),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  expect(await github.observeMergeHistory("2026-08-18")).toEqual([
    {
      number: 103,
      title: "Port API to Express",
      headRefName: "feature/next-to-express",
      mergedAt: "2026-08-18T01:25:50Z",
    },
  ]);
  expect(runner.commands[0]).toContain("merged");
  expect(runner.commands[0]).toContain("merged:>=2026-08-18");
  expect(runner.commands[0]?.at(-1)).toBe("number,title,headRefName,mergedAt");
});

test("repair observation does not request landing-only fields", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify([
      {
        number: 5,
        headRefName: "issue-2-old-slug",
        headRefOid: "cafe1234",
        mergeable: "A_FUTURE_VALUE",
        statusCheckRollup: [],
      },
    ]),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  const observed = (await github.observeRepairChanges())[0];
  expect(observed?.mergeable).toBe("A_FUTURE_VALUE");
  expect(observed?.headSha).toBe("cafe1234");
  expect(runner.commands[0]?.at(-1)).toBe(
    "number,headRefName,headRefOid,mergeable,labels,statusCheckRollup,additions,deletions",
  );
});

test("review-thread observation follows pagination cursors and sums every page", async () => {
  const runner = new RecordingRunner();
  const page = (nodes: { isResolved: boolean }[], pageInfo: unknown) =>
    JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } },
    });
  runner.responses = [
    page([{ isResolved: false }, { isResolved: true }], { hasNextPage: true, endCursor: "C1" }),
    page([{ isResolved: false }], { hasNextPage: false, endCursor: "C2" }),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  expect(await github.unresolvedThreadCount(7)).toBe(2);
  expect(runner.commands).toHaveLength(2);
  expect(runner.commands[0]).not.toContain("cursor=C1");
  expect(runner.commands[1]).toContain("cursor=C1");
});

test("a later page failure preserves already-proven unresolved threads as a lower bound", async () => {
  const page = (nodes: { isResolved: boolean }[], pageInfo: unknown) =>
    JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } },
    });
  const positive = new RecordingRunner();
  positive.responses = [
    page([{ isResolved: false }], { hasNextPage: true, endCursor: "C1" }),
    "not json",
  ];
  const github = new GitHubService(positive, { repositoryPath: "/repo", repository: "o/r" });
  expect(await github.unresolvedThreadCount(7)).toBe(1);

  // With nothing proven yet, the failure propagates (landing fails closed).
  const empty = new RecordingRunner();
  empty.responses = [
    page([{ isResolved: true }], { hasNextPage: true, endCursor: "C1" }),
    "not json",
  ];
  const github2 = new GitHubService(empty, { repositoryPath: "/repo", repository: "o/r" });
  await expect(github2.unresolvedThreadCount(7)).rejects.toThrow("invalid JSON");
});

test("a non-advancing review-thread cursor stops the loop instead of spinning forever", async () => {
  const page = (nodes: { isResolved: boolean }[], endCursor: string) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: true, endCursor }, nodes },
          },
        },
      },
    });
  // Proven unresolved threads survive the cycle as a lower bound; the
  // repeated page may repeat its nodes, so none of it is counted.
  const positive = new RecordingRunner();
  positive.responses = [page([{ isResolved: false }], "C1"), page([{ isResolved: false }], "C1")];
  const github = new GitHubService(positive, { repositoryPath: "/repo", repository: "o/r" });
  expect(await github.unresolvedThreadCount(7)).toBe(1);
  expect(positive.commands).toHaveLength(2);

  const empty = new RecordingRunner();
  empty.responses = [page([{ isResolved: true }], "C1"), page([{ isResolved: true }], "C1")];
  const github2 = new GitHubService(empty, { repositoryPath: "/repo", repository: "o/r" });
  await expect(github2.unresolvedThreadCount(7)).rejects.toThrow("cursor did not advance");
});

test("a list page that fills the limit is refetched larger until the result fits", async () => {
  const heads = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ number: i + 1, headRefName: `issue-${i + 1}-x` }));
  const runner = new RecordingRunner();
  runner.responses = [JSON.stringify(heads(100)), JSON.stringify(heads(150))];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  expect(await github.observeOpenChangeHeads()).toHaveLength(150);
  expect(runner.commands[0]).toContain("100");
  expect(runner.commands[1]).toContain("200");
});

test("a list still truncated at the limit cap throws instead of returning a partial view", async () => {
  const heads = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ number: i + 1, headRefName: `issue-${i + 1}-x` }));
  const runner = new RecordingRunner();
  runner.responses = [100, 200, 400, 800, 1600, 3200, 6400].map((n) => JSON.stringify(heads(n)));
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  await expect(github.observeOpenChangeHeads()).rejects.toThrow("truncated");
});

test("a repair observation without headRefOid stays undefined instead of throwing", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify([{ number: 5, headRefName: "issue-2-x", mergeable: "MERGEABLE" }]),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  expect((await github.observeRepairChanges())[0]?.headSha).toBeUndefined();
});

test("addLabel creates the label idempotently before adding it to the PR", async () => {
  const runner = new RecordingRunner();
  runner.responses = ["", ""];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  await github.addLabel(9, "repair-exhausted");

  expect(runner.commands.map((command) => command.slice(0, 4))).toEqual([
    ["gh", "label", "create", "repair-exhausted"],
    ["gh", "pr", "edit", "9"],
  ]);
  expect(runner.commands[0]).toContain("--force");
  expect(runner.commands[1]?.slice(-2)).toEqual(["--add-label", "repair-exhausted"]);
});

test("addLabel: death after `label create`, before `pr edit` — the retry re-creates (an upsert) and attaches once (RETRIED)", async () => {
  class DyingRunner extends RecordingRunner {
    dieOnEdit = true;
    override async run(command: readonly string[], options: RunCommandOptions) {
      const result = await super.run(command, options);
      if (this.dieOnEdit && command[1] === "pr" && command[2] === "edit") {
        return { ...result, exitCode: 1, stderr: "connection reset" };
      }
      return result;
    }
  }
  const runner = new DyingRunner();
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  await expect(github.addLabel(9, "repair-exhausted")).rejects.toThrow();
  expect(runner.commands.map((command) => command[1])).toEqual(["label", "pr"]);

  // Next tick: `label create --force` is an upsert, so re-running it over the
  // label the first attempt created changes nothing; the attach then lands.
  runner.dieOnEdit = false;
  await github.addLabel(9, "repair-exhausted");
  expect(runner.commands.map((command) => command.slice(1, 3))).toEqual([
    ["label", "create"],
    ["pr", "edit"],
    ["label", "create"],
    ["pr", "edit"],
  ]);
  expect(runner.commands.filter((command) => command[2] === "edit")).toHaveLength(2);
  expect(runner.commands[2]).toContain("--force");
});

test("hasComment finds the marker anywhere in the PR conversation, and only there", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify({ comments: [{ body: "lgtm" }, { body: "<!-- m -->\nparked" }] }),
    JSON.stringify({ comments: [{ body: "unrelated" }] }),
    JSON.stringify({}),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  expect(await github.hasComment(9, "<!-- m -->")).toBe(true);
  expect(await github.hasComment(9, "<!-- m -->")).toBe(false);
  // A PR view without a comments array reads as no comment, not a crash.
  expect(await github.hasComment(9, "<!-- m -->")).toBe(false);
  expect(runner.commands[0]).toEqual(["gh", "pr", "view", "9", "--json", "comments"]);
});

test("comment posts the body as one argument, never through a shell", async () => {
  const runner = new RecordingRunner();
  runner.responses = [""];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  await github.comment(9, "line one\n`code` $(not run)");

  expect(runner.commands[0]).toEqual([
    "gh",
    "pr",
    "comment",
    "9",
    "--body",
    "line one\n`code` $(not run)",
  ]);
});

test("observeReviewThreads follows pagination and reduces each thread to its root comment's facts", async () => {
  const runner = new RecordingRunner();
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    isResolved: false,
    path: "src/a.ts",
    originalLine: 12,
    resolvedBy: null,
    comments: {
      nodes: [
        {
          createdAt: "2026-10-16T00:00:00Z",
          author: { login: "chatgpt-codex-connector" },
          originalCommit: { oid: "abc" },
        },
      ],
    },
    ...extra,
  });
  runner.responses = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [node("T1")],
            },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                node("T2", {
                  isResolved: true,
                  resolvedBy: { login: "gendev1" },
                  originalLine: null,
                  comments: { nodes: [{ createdAt: "x", author: null, originalCommit: null }] },
                }),
              ],
            },
          },
        },
      },
    }),
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });

  const threads = await github.observeReviewThreads(9);

  expect(threads).toEqual([
    {
      id: "T1",
      path: "src/a.ts",
      originalLine: 12,
      originalCommit: "abc",
      author: "chatgpt-codex-connector",
      createdAt: "2026-10-16T00:00:00Z",
      isResolved: false,
      resolvedBy: undefined,
    },
    {
      id: "T2",
      path: "src/a.ts",
      originalLine: null,
      originalCommit: undefined,
      author: undefined,
      createdAt: "x",
      isResolved: true,
      resolvedBy: "gendev1",
    },
  ]);
  expect(runner.commands[1]).toContain("cursor=c1");
});

test("observeReviewThreads throws on a page failure instead of returning a partial list", async () => {
  const runner = new RecordingRunner();
  runner.responses = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] },
          },
        },
      },
    }),
    "not json",
  ];
  const github = new GitHubService(runner, { repositoryPath: "/repo", repository: "o/r" });
  await expect(github.observeReviewThreads(9)).rejects.toThrow("invalid JSON");
});
