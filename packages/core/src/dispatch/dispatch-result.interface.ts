export interface DispatchFailure {
  readonly issueNumber: number;
  readonly message: string;
}

export interface DispatchBlock {
  readonly issueNumber: number;
  readonly reasons: readonly ("DEPENDENCY_INCOMPLETE" | "ALREADY_IN_FLIGHT")[];
}

/**
 * The capacity decision, reported on every run — including the early return
 * at zero slots, which previously exited before a single observation could
 * be logged (#65).
 */
export interface DispatchCapacity {
  readonly active: number;
  readonly max: number;
  /** Branch identities of the worktrees holding the active slots; empty iff active is 0. */
  readonly heldBy: readonly string[];
  /** Every slot is held while eligible candidates wait — the tick that used to exit silently. */
  readonly starved: boolean;
}

export interface DispatchResult {
  readonly started: readonly number[];
  readonly planned: readonly number[];
  readonly blocked: readonly DispatchBlock[];
  readonly failed: readonly DispatchFailure[];
  readonly capacity: DispatchCapacity;
}
