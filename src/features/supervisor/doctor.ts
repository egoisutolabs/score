import { configPath } from "@/features/config/layout";
import { loadConfig } from "@/features/config/load";

/**
 * Deliberately format-only (epic decision): the daemon's own preflight owns
 * environment checks, and collision safety lives in `up`'s reconciler.
 * TODO(future): once Score ships as an npm package, report whether an upgrade
 * is available (`npm view score version` vs the running version).
 */
export async function runDoctor(): Promise<void> {
  const path = configPath();
  try {
    const config = await loadConfig(path);
    const projects = Object.values(config.projects);
    const enabled = projects.filter((project) => project.enabled).length;
    console.log(`config ok (${projects.length} projects, ${enabled} enabled)`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`no config at ${path} — run: score config init`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`config is invalid: ${message}`);
    }
    process.exitCode = 1;
  }
}
