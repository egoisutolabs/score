// Pure decisions for D1 unpushed-merge recovery: whether a stray
// default-branch head is provably landing's own merge. No git, no IO —
// daemon.run.ts gathers the evidence and acts on the verdict.
import type { CommitObservation } from "@score/core/adapters/git.service";
import { LANDING_COMMITTER } from "@score/core/adapters/git.service";

/** Evidence for the landing-authorship proof, gathered by the caller. */
export interface StrayCommitEvidence {
  readonly commit: CommitObservation;
  /** commit.parents[0] is an ancestor of (or equal to) origin's default-branch head. */
  readonly firstParentReachableFromOrigin: boolean;
  /** Owner half of the GitHub repo; landing's merge template embeds it. */
  readonly repositoryOwner: string;
}

export type LandingAuthorshipProof =
  | { readonly proven: true; readonly pullRequestNumber: number }
  | { readonly proven: false; readonly evidence: string };

/**
 * The four-check landing-authorship proof (D1, issue #41): a stray unpushed
 * default-branch head may only be reset away when it is provably landing's
 * own merge — a merge commit, grown directly from origin's history, carrying
 * landing's exact message template, stamped with landing's committer
 * identity. Pure, so each check is unit-testable without a repository.
 */
export function proveLandingAuthorship(stray: StrayCommitEvidence): LandingAuthorshipProof {
  const { commit } = stray;
  if (commit.parents.length !== 2) {
    return {
      proven: false,
      evidence: `not a merge commit (${commit.parents.length} parent(s))`,
    };
  }
  if (!stray.firstParentReachableFromOrigin) {
    // Ancestor-of, not equal-to: origin advancing during the outage must not
    // strand recovery. This check is also the "more than one stray commit"
    // guard — any commit stacked between origin's head and this merge makes
    // the first parent unreachable from origin.
    return {
      proven: false,
      evidence: `first parent ${commit.parents[0]} is not an ancestor of origin's head`,
    };
  }
  const firstLine = commit.message.split("\n", 1)[0] ?? "";
  const template = firstLine.match(/^Merge pull request #(\d+) from (\S+)$/);
  if (template === null || !(template[2] as string).startsWith(`${stray.repositoryOwner}/`)) {
    return {
      proven: false,
      evidence: `message ${JSON.stringify(firstLine)} does not match landing's merge template`,
    };
  }
  // The stamp is required, not corroborating (D1): checks 1-3 are satisfiable
  // by an ordinary operator merge made with the same ambient identity, so an
  // unstamped candidate — including strays predating the stamp — is never
  // auto-reset; it surfaces as a warning and is resolved by hand once. Both
  // halves of the identity must match: commitMerge stamps name and email.
  if (
    commit.committerName !== LANDING_COMMITTER.name ||
    commit.committerEmail !== LANDING_COMMITTER.email
  ) {
    return {
      proven: false,
      evidence: `committer ${commit.committerName} <${commit.committerEmail}> is not landing's stamp ${LANDING_COMMITTER.name} <${LANDING_COMMITTER.email}>`,
    };
  }
  return { proven: true, pullRequestNumber: Number(template[1]) };
}
