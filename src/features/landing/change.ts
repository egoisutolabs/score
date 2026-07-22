import type { Label } from "@/features/dispatch/issue";
import type { Command } from "@/shared/command";

export interface CheckRun {
  readonly status: string;
  readonly conclusion?: string | null;
}

export interface StatusContext {
  readonly state: string;
}

export type ChangeCheck = CheckRun | StatusContext;

export interface PullRequestObservation {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly isDraft: boolean;
  readonly mergeable: string;
  readonly reviewDecision: string | null;
  readonly labels: readonly Label[];
  readonly files: readonly { readonly path: string }[];
  readonly statusCheckRollup: readonly ChangeCheck[];
  readonly mergedAt?: string | null;
}

export interface PullRequestIdentity {
  readonly number: number;
  readonly headRefName: string;
  readonly mergedAt?: string | null;
}

export interface RepairPullRequestObservation {
  readonly number: number;
  readonly headRefName: string;
  /** Lets a caller tell "the agent pushed something" from "nothing moved". */
  readonly headSha?: string;
  readonly mergeable: string;
  readonly statusCheckRollup: readonly ChangeCheck[];
}

export interface BuildStep {
  readonly label: string;
  readonly command: Command;
  readonly retry?: boolean;
}

export interface BuildGate {
  readonly name: string;
  readonly cwd: string;
  readonly steps: readonly BuildStep[];
}

export type LandingTag =
  | "skipped"
  | "would-merge"
  | "conflict"
  | "changes-requested"
  | "checks-red"
  | "checks-pending"
  | "unresolved"
  | "build-red"
  | "soaking"
  | "ready"
  | "merged";

export interface LandingResult {
  readonly pullRequestNumber: number;
  readonly tag: LandingTag;
  readonly note: string;
  readonly keepTimer?: boolean;
}
