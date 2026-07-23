import { mkdir, writeFile } from "node:fs/promises";
import { configPath, scoreHome } from "@/features/config/layout";

/** Starter config: every field present, the one example project commented out. */
export const CONFIG_TEMPLATE = `// Score fleet configuration — edit, then run \`score up\`.
{
  "version": 1, // config schema version; must be 1
  "log_retention_days": 30, // daemon log files older than this many days are deleted
  "projects": {
    // One entry per project; keys must match [a-z0-9-].
    // Uncomment and edit this example to add your first project:
    // "score": {
    //   "enabled": true, // false is treated like removed: \`score up\` will not start it
    //   "main_location": "~/Desktop/build-week/score", // the daemon's own checkout (single writer)
    //   "worktree_location": "~/wt/score", // where per-issue worktrees are created
    //   "github_repo": "egoisutolabs/score", // owner/repo on GitHub
    //   "config": {
    //     "tick_interval_ms": 60000, // poll-loop interval, in milliseconds
    //     "max_parallel": 2, // how many issues may be in flight at once
    //     "agent": { "harness": "claude", "model": "claude-sonnet-5" }, // harness must be "claude"
    //     "auto_merge": true, // merge green approved PRs automatically
    //   },
    // },
  },
}
`;

export async function runConfigInit(): Promise<void> {
  const path = configPath();
  await mkdir(scoreHome(), { recursive: true });
  try {
    // "wx" fails on an existing file, so a repeat run never touches it.
    await writeFile(path, CONFIG_TEMPLATE, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(`${path} already exists — not touching it`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log(`wrote ${path}`);
}
