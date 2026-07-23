import type { IssueComment, IssueObservation, Label } from "@/features/dispatch/issue";
import type { ChangeCheck, PullRequestObservation, StatusContext } from "@/features/landing/change";
import type { UnknownRecord } from "@/shared/validation";
import {
  arrayValue,
  booleanValue,
  enumValue,
  objectValue,
  positiveIntegerValue,
  stringValue,
  textValue,
} from "@/shared/validation";

const ISSUE_STATES = ["OPEN", "CLOSED"] as const;
const ISSUE_STATE_REASONS = ["COMPLETED", "NOT_PLANNED", "REOPENED"] as const;

/**
 * gh serializes GraphQL nulls as "" across nullable string fields
 * (reviewDecision, check conclusions, stateReason); "" always means absent.
 */
function ghNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return stringValue(value, path);
}

/** gh serializes "no state reason" on open issues as "", not null; treat both as absent. */
export function issueStateReason(
  value: unknown,
  path: string,
): (typeof ISSUE_STATE_REASONS)[number] | null {
  if (value === null || value === undefined || value === "") return null;
  return enumValue(value, ISSUE_STATE_REASONS, path);
}

/** Converts untrusted `gh issue` JSON into the issue model. */
export function parseGithubIssue(value: unknown, path = "github.issue"): IssueObservation {
  const issue = objectValue(value, path);
  return {
    number: positiveIntegerValue(issue.number, `${path}.number`),
    title: stringValue(issue.title, `${path}.title`),
    body:
      issue.body === null || issue.body === undefined ? "" : textValue(issue.body, `${path}.body`),
    labels: optionalArray(issue.labels, `${path}.labels`).map((label, index) =>
      parseLabel(label, `${path}.labels[${index}]`),
    ),
    state: enumValue(issue.state, ISSUE_STATES, `${path}.state`),
    stateReason: issueStateReason(issue.stateReason, `${path}.stateReason`),
    url: urlValue(issue.url, `${path}.url`),
    comments: optionalArray(issue.comments, `${path}.comments`).map((comment, index) =>
      parseComment(comment, `${path}.comments[${index}]`),
    ),
  };
}

export function parseGithubIssues(value: unknown): readonly IssueObservation[] {
  return arrayValue(value, "github.issues").map((issue, index) =>
    parseGithubIssue(issue, `github.issues[${index}]`),
  );
}

/** Converts untrusted `gh pr` JSON while preserving unknown mergeability as fail-closed state. */
export function parseGithubPullRequest(
  value: unknown,
  path = "github.pullRequest",
): PullRequestObservation {
  const change = objectValue(value, path);
  return {
    number: positiveIntegerValue(change.number, `${path}.number`),
    title: textValue(change.title, `${path}.title`),
    headRefName: stringValue(change.headRefName, `${path}.headRefName`),
    headSha: optionalString(change.headRefOid, `${path}.headRefOid`),
    baseSha: optionalString(change.baseRefOid, `${path}.baseRefOid`),
    isDraft: change.isDraft === undefined ? false : booleanValue(change.isDraft, `${path}.isDraft`),
    mergeable:
      change.mergeable === undefined
        ? "UNKNOWN"
        : stringValue(change.mergeable, `${path}.mergeable`),
    reviewDecision: ghNullableString(change.reviewDecision, `${path}.reviewDecision`),
    labels: optionalArray(change.labels, `${path}.labels`).map((label, index) =>
      parseLabel(label, `${path}.labels[${index}]`),
    ),
    files: optionalArray(change.files, `${path}.files`).map((file, index) => ({
      path: stringValue(
        objectValue(file, `${path}.files[${index}]`).path,
        `${path}.files[${index}].path`,
      ),
    })),
    statusCheckRollup: optionalArray(change.statusCheckRollup, `${path}.statusCheckRollup`).flatMap(
      (check, index) => {
        const parsed = parseChangeCheck(check, `${path}.statusCheckRollup[${index}]`);
        return parsed ? [parsed] : [];
      },
    ),
    mergedAt: ghNullableString(change.mergedAt, `${path}.mergedAt`),
  };
}

export function parseGithubPullRequests(value: unknown): readonly PullRequestObservation[] {
  return arrayValue(value, "github.pullRequests").map((change, index) =>
    parseGithubPullRequest(change, `github.pullRequests[${index}]`),
  );
}

export function parseRepositoryName(value: unknown): string {
  return stringValue(
    objectValue(value, "github.repository").nameWithOwner,
    "github.repository.nameWithOwner",
  );
}

export function parseUnresolvedThreadCount(value: unknown): number {
  const root = optionalObject(value);
  const data = optionalObject(root?.data);
  const repository = optionalObject(data?.repository);
  const pullRequest = optionalObject(repository?.pullRequest);
  const reviewThreads = optionalObject(pullRequest?.reviewThreads);
  if (reviewThreads?.nodes === undefined || reviewThreads.nodes === null) return 0;
  return arrayValue(reviewThreads.nodes, "github.graphql.reviewThreads.nodes").filter(
    (node, index) => !objectValue(node, `github.graphql.reviewThreads.nodes[${index}]`).isResolved,
  ).length;
}

function optionalObject(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function parseLabel(value: unknown, path: string): Label {
  return { name: stringValue(objectValue(value, path).name, `${path}.name`) };
}

function parseComment(value: unknown, path: string): IssueComment {
  const comment = objectValue(value, path);
  const author = comment.author;
  return {
    author:
      author === null || author === undefined
        ? author
        : {
            login: stringValue(objectValue(author, `${path}.author`).login, `${path}.author.login`),
          },
    body: textValue(comment.body, `${path}.body`),
  };
}

function parseChangeCheck(value: unknown, path: string): ChangeCheck | null {
  const check = objectValue(value, path);
  if (check.status !== undefined) {
    return {
      status: stringValue(check.status, `${path}.status`),
      conclusion: ghNullableString(check.conclusion, `${path}.conclusion`),
    };
  }
  if (check.state !== undefined) {
    const state: StatusContext["state"] = stringValue(check.state, `${path}.state`);
    return { state };
  }
  return null;
}

function optionalArray(value: unknown, path: string): readonly unknown[] {
  return value === undefined || value === null ? [] : arrayValue(value, path);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : stringValue(value, path);
}

function urlValue(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  try {
    new URL(parsed);
  } catch {
    throw new Error(`${path} must be a valid URL`);
  }
  return parsed;
}
