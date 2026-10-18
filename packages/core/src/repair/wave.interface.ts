import type { RepairDefects } from "@score/core/repair/repair.policy";

/** One repair wave as the ledger recorded it: what the agent was sent to fix, and when. */
export interface WaveRecord {
  readonly at: string;
  readonly tick: number;
  readonly headSha: string | undefined;
  readonly defects: RepairDefects;
  /** Findings the reviewer still held open on GitHub when the wave was sent, once per key. */
  readonly openFindings: number;
  /** additions + deletions of the head the wave was sent to fix; undefined when GitHub did not say. */
  readonly diffSize: number | undefined;
  /** Content version of the repair prompt this wave carried (prompts/repair.render.ts). */
  readonly promptVersion: string;
}

export interface RepairExhaustion {
  readonly budget: number;
  readonly waves: readonly WaveRecord[];
  /** Which convergence rule parked the PR, and the numbers behind it. */
  readonly rule: string;
  readonly detail: string;
}
