export interface DispatchFailure {
  readonly issueNumber: number;
  readonly message: string;
}

export interface DispatchBlock {
  readonly issueNumber: number;
  readonly reasons: readonly ("DEPENDENCY_INCOMPLETE" | "ALREADY_IN_FLIGHT")[];
}

export interface DispatchResult {
  readonly started: readonly number[];
  readonly planned: readonly number[];
  readonly blocked: readonly DispatchBlock[];
  readonly failed: readonly DispatchFailure[];
}
