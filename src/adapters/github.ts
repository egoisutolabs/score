import { requireSuccess } from "@/adapters/command-runner";
import {
  issueStateReason,
  parseGithubIssue,
  parseGithubIssues,
  parseGithubPullRequests,
  parseRepositoryName,
  parseUnresolvedThreadCount,
} from "@/adapters/github-parsers";
import type { DependencyObservation, IssueObservation } from "@/features/dispatch/issue";
import type { WorkSource } from "@/features/dispatch/work-source";
import type {
  PullRequestIdentity,
  PullRequestObservation,
  RepairPullRequestObservation,
} from "@/features/landing/change";
import type { ChangeHost } from "@/features/landing/port";
import type { CommandRunner } from "@/shared/command-runner";
import { arrayValue, objectValue, positiveIntegerValue, stringValue } from "@/shared/validation";

interface GitHubServiceOptions {
  readonly repositoryPath: string;
  readonly repository: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
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
      await this.#json([
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,title,body,labels,state,stateReason,url",
      ]),
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
    const raw = arrayValue(
      await this.#json([
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,headRefName,headRefOid,mergeable,statusCheckRollup",
      ]),
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
    return changes.filter((change) => /^issue-\d+-/.test(change.headRefName));
  }

  async #observeChangeIdentities(
    state: "open" | "merged",
    fields: string,
  ): Promise<readonly PullRequestIdentity[]> {
    const raw = arrayValue(
      await this.#json(["pr", "list", "--state", state, "--limit", "100", "--json", fields]),
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
      "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$num){reviewThreads(first:100){nodes{isResolved}}}}}";
    return parseUnresolvedThreadCount(
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
      ]),
    );
  }

  async #observeChanges(state: "open" | "merged"): Promise<readonly PullRequestObservation[]> {
    return parseGithubPullRequests(
      await this.#json([
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        "100",
        "--json",
        "number,title,headRefName,headRefOid,baseRefOid,isDraft,mergeable,labels,files,reviewDecision,statusCheckRollup,mergedAt",
      ]),
    );
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
