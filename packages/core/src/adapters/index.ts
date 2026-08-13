/**
 * Local VCS adapter: GitService implements the WorktreeProvisioner and
 * LandingWorkspace ports. Lives in core by documented exception (see
 * AGENTS.md). Executes VCS operations only; callers own policy and role
 * authorization.
 */
export * from "./git.service";
