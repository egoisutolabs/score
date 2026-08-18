import type { WarningReason } from "../telemetry/stream-envelope.interface";

export interface GitHubMergeView {
  readonly project: string;
  readonly pull_request_number: number;
  readonly title: string;
  readonly merged_at: string;
}

export type HistoryOutcome =
  | {
      readonly kind: "ok";
      readonly merges: readonly GitHubMergeView[];
      readonly warnings: readonly { readonly reason: WarningReason }[];
    }
  | {
      readonly kind: "error";
      readonly status: 503;
      readonly reason: "CONFIG_UNPARSEABLE";
    };
