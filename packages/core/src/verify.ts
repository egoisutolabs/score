/**
 * Score's one contract with every target project: `make verify` at the
 * repository root must run that project's full verification and exit nonzero
 * on failure. The repo owns the recipe (versioned with the code, so landing's
 * merged-tree gate runs the merged tree's own definition); Score owns only the
 * target name. No per-project config, no language assumptions.
 */
export const VERIFY_COMMAND = "make verify";
export const VERIFY_ARGV = ["make", "verify"] as const;
