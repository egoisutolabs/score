import { isIssueBranch } from "@score/core/dispatch/dispatch.identity";
import type { DependencyObservation, IssueObservation } from "@score/core/dispatch/issue.interface";
import type { WorkSource } from "@score/core/dispatch/work-source.interface";
import type {
  PullRequestIdentity,
  PullRequestObservation,
  RepairPullRequestObservation,
} from "@score/core/landing/change.interface";
import type { ChangeHost } from "@score/core/landing/change-host.interface";
import { requireSuccess } from "@score/shared/adapters/command-runner.service";
import type { CommandRunner } from "@score/shared/command-runner.interface";
import {
  arrayValue,
  objectValue,
  positiveIntegerValue,
  stringValue,
} from "@score/shared/validation";
import {
  issueStateReason,
  parseGithubIssue,
  parseGithubIssues,
  parseGithubPullRequests,
  parseRepositoryName,
  parseUnresolvedThreadPage,
  type ReviewThreadPage,
} from "@score/tracker/github-parsers";

/**
 * A refetch that reaches this many results without fitting under the limit
 * gives up rather than looping; callers treat the throw as a failed
 * observation (fail closed), never a partial view.
 */
// ponytail: doubling --limit refetch; switch to `gh api` cursor pagination if a repo ever exceeds the cap
const LIST_LIMIT_CAP = 6400;

interface GitHubServiceOptions {
  readonly repositoryPath: string;
  readonly repository: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
}

/** Provider facts used by read-only history views, independent of Score ownership. */
export interface GitHubMergeHistory {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string;
  readonly mergedAt: string;
}

/** Validated GitHub observation adapter; it does not make scheduling or landing decisions. */
export class GitHubService implements WorkSource, ChangeHost {
  readonly #executable: string;
  readonly #timeoutMs: number | undefined;

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: GitHubServiceOptions,
  ) {
    this.#executable = this.options.executable ?? "gh";
    this.#timeoutMs = this.options.timeoutMs;
  }

  async preflight(): Promise<void> {
    requireSuccess(await this.#run(["auth", "status"]));
    const observed = parseRepositoryName(
      await this.#json(["repo", "view", "--json", "nameWithOwner"]),
    );
    if (observed !== this.options.repository) {
      throw new Error(
        `configured repository ${this.options.repository} does not match gh repository ${observed}`,
      );
    }
  }

  async observeIssues(): Promise<readonly IssueObservation[]> {
    return parseGithubIssues(
      await this.#listComplete(
        ["issue", "list", "--state", "open"],
        "number,title,body,labels,state,stateReason,url",
        200,
        "github.issues",
      ),
    );
  }

  async observeIssue(issueNumber: number): Promise<IssueObservation> {
    return parseGithubIssue(
      await this.#json([
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "number,title,body,labels,state,stateReason,url,comments",
      ]),
    );
  }

  async observeDependency(issueNumber: number): Promise<DependencyObservation> {
    const value = objectValue(
      await this.#json([
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "number,state,stateReason",
      ]),
      "github.dependency",
    );
    const state = stringValue(value.state, "github.dependency.state");
    const reason = issueStateReason(value.stateReason, "github.dependency.stateReason");
    return {
      number: positiveIntegerValue(value.number, "github.dependency.number"),
      state,
      stateReason: reason,
    };
  }

  async observeOpenChanges(): Promise<readonly PullRequestObservation[]> {
    return this.#observeChanges("open");
  }

  async observeOpenChangeHeads(): Promise<readonly PullRequestIdentity[]> {
    return this.#observeChangeIdentities("open", "number,headRefName");
  }

  async observeRepairChanges(): Promise<readonly RepairPullRequestObservation[]> {
    const raw = await this.#listComplete(
      ["pr", "list", "--state", "open"],
      "number,headRefName,headRefOid,mergeable,statusCheckRollup",
      100,
      "github.repairPullRequests",
    );
    return raw.map((item, index) => {
      const path = `github.repairPullRequests[${index}]`;
      const value = objectValue(item, path);
      const parsed = parseGithubPullRequests([
        {
          number: value.number,
          title: "",
          headRefName: value.headRefName,
          headRefOid: value.headRefOid,
          mergeable: value.mergeable,
          statusCheckRollup: value.statusCheckRollup,
        },
      ])[0];
      if (!parsed) throw new Error(`${path} is missing`);
      return {
        number: parsed.number,
        headRefName: parsed.headRefName,
        headSha: parsed.headSha,
        mergeable: parsed.mergeable,
        statusCheckRollup: parsed.statusCheckRollup,
      };
    });
  }

  async observeMergedOwnedChanges(): Promise<readonly PullRequestIdentity[]> {
    const changes = await this.#observeChangeIdentities("merged", "number,headRefName,mergedAt");
    return changes.filter((change) => isIssueBranch(change.headRefName));
  }

  async observeMergeHistory(sinceDay?: string): Promise<readonly GitHubMergeHistory[]> {
    const raw = await this.#listComplete(
      [
        "pr",
        "list",
        "--state",
        "merged",
        ...(sinceDay === undefined ? [] : ["--search", `merged:>=${sinceDay}`]),
      ],
      "number,title,headRefName,mergedAt",
      100,
      "github.mergeHistory",
    );
    return raw.map((item, index) => {
      const path = `github.mergeHistory[${index}]`;
      const value = objectValue(item, path);
      return {
        number: positiveIntegerValue(value.number, `${path}.number`),
        title: stringValue(value.title, `${path}.title`),
        headRefName: stringValue(value.headRefName, `${path}.headRefName`),
        mergedAt: stringValue(value.mergedAt, `${path}.mergedAt`),
      };
    });
  }

  // gh's "closed" state is GraphQL CLOSED — closed without merging — so this
  // set is disjoint from observeMergedOwnedChanges, not a superset of it.
  async observeClosedOwnedChanges(): Promise<readonly PullRequestIdentity[]> {
    const changes = await this.#observeChangeIdentities("closed", "number,headRefName");
    return changes.filter((change) => isIssueBranch(change.headRefName));
  }

  async #observeChangeIdentities(
    state: "open" | "merged" | "closed",
    fields: string,
  ): Promise<readonly PullRequestIdentity[]> {
    const raw = await this.#listComplete(
      ["pr", "list", "--state", state],
      fields,
      100,
      "github.pullRequestIdentities",
    );
    return raw.map((item, index) => {
      const path = `github.pullRequestIdentities[${index}]`;
      const value = objectValue(item, path);
      return {
        number: positiveIntegerValue(value.number, `${path}.number`),
        headRefName: stringValue(value.headRefName, `${path}.headRefName`),
        mergedAt: typeof value.mergedAt === "string" ? value.mergedAt : undefined,
      };
    });
  }

  async unresolvedThreadCount(pullRequestNumber: number): Promise<number> {
    const [owner, name] = this.options.repository.split("/");
    if (!owner || !name) throw new Error("repository must use owner/name form");

    const query =
      "query($owner:String!,$repo:String!,$num:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$num){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{isResolved}}}}}";
    let unresolved = 0;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      let page: ReviewThreadPage;
      try {
        page = parseUnresolvedThreadPage(
          await this.#json([
            "api",
            "graphql",
            "-f",
            `query=${query}`,
            "-F",
            `owner=${owner}`,
            "-F",
            `repo=${name}`,
            "-F",
            `num=${pullRequestNumber}`,
            ...(cursor === null ? [] : ["-f", `cursor=${cursor}`]),
          ]),
        );
      } catch (error) {
        // A proven unresolved thread outlives a later page failure: the
        // partial count is a lower bound, enough for landing to block and
        // repair to act. With nothing proven yet, the failure propagates.
        if (unresolved > 0) return unresolved;
        throw error;
      }
      // A repeated cursor would re-issue the same successful query forever
      // (the runner timeout bounds one command, not this loop), and a page
      // that repeats a cursor may repeat its nodes too — so the whole page
      // is malformed evidence, handled like a failed page before any of it
      // is counted: keep the previously proven lower bound, else propagate.
      if (page.endCursor !== null && seenCursors.has(page.endCursor)) {
        if (unresolved > 0) return unresolved;
        throw new Error(`github.graphql.reviewThreads cursor did not advance (${page.endCursor})`);
      }
      unresolved += page.unresolved;
      cursor = page.endCursor;
      if (cursor !== null) seenCursors.add(cursor);
    } while (cursor !== null);
    return unresolved;
  }

  async #observeChanges(state: "open" | "merged"): Promise<readonly PullRequestObservation[]> {
    return parseGithubPullRequests(
      await this.#listComplete(
        ["pr", "list", "--state", state],
        "number,title,headRefName,headRefOid,baseRefOid,isDraft,mergeable,labels,files,reviewDecision,statusCheckRollup,mergedAt",
        100,
        "github.pullRequests",
      ),
    );
  }

  /**
   * gh list endpoints truncate silently at --limit; a page that fills the
   * limit is treated as possibly-truncated and refetched larger until the
   * result fits, so no caller ever acts on a partial view.
   */
  async #listComplete(
    args: readonly string[],
    fields: string,
    initialLimit: number,
    path: string,
  ): Promise<readonly unknown[]> {
    let limit = initialLimit;
    for (;;) {
      const raw = arrayValue(
        await this.#json([...args, "--limit", String(limit), "--json", fields]),
        path,
      );
      if (raw.length < limit) return raw;
      if (limit >= LIST_LIMIT_CAP)
        throw new Error(`${path} observation still truncated at ${limit} results`);
      limit *= 2;
    }
  }

  async #json(args: readonly string[]): Promise<unknown> {
    const result = requireSuccess(await this.#run(args));
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`gh returned invalid JSON: ${String(error)}`);
    }
  }

  #run(args: readonly string[]) {
    return this.runner.run([this.#executable, ...args], {
      cwd: this.options.repositoryPath,
      timeoutMs: this.#timeoutMs,
    });
  }
}
