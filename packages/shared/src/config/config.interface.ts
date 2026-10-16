export interface AgentConfig {
  harness: "claude" | "opencode";
  /** Absent = the harness's own default model (the manual repair path). */
  model?: string;
}

export interface ProjectRuntimeConfig {
  tick_interval_ms?: number;
  max_parallel?: number;
  agent: AgentConfig;
  auto_merge?: boolean;
  /** Wall-clock wait after a head is first seen before a clean PR may stage (late reviewer rounds). */
  review_settle_ms?: number;
}

export interface ProjectConfig {
  enabled: boolean;
  main_location: string;
  worktree_location: string;
  github_repo: string;
  config: ProjectRuntimeConfig;
}

export interface ScoreConfig {
  version: 1;
  log_retention_days?: number;
  projects: Record<string, ProjectConfig>;
}

export interface ResolvedProject {
  key: string;
  mainLocation: string;
  worktreeLocation: string;
  githubRepo: string;
  tickIntervalMs: number;
  maxParallel: number;
  agent: AgentConfig;
  autoMerge: boolean;
  reviewSettleMs: number;
  logRetentionDays: number;
  configHash: string;
}
