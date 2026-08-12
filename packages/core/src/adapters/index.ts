/**
 * Local VCS adapter: GitService implements the WorkspaceDriver port.
 * Lives in core by documented exception (see AGENTS.md). Executes VCS
 * operations only; callers own policy and role authorization.
 */
export * from "./git.service";
