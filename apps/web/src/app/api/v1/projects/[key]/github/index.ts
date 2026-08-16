// github — GET /api/v1/projects/[key]/github: live GitHub observation (open
// PRs with landing's verdicts, open-issue count), read-only over the
// daemon's own adapter. Mutating verbs refused.
export * from "./route";
