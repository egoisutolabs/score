import { crashLogPath } from "@/features/config/layout";
import type { ResolvedProject } from "@/features/config/model";

/** Job namespace: `score down` with no key touches these labels and nothing else. */
export const LABEL_PREFIX = "dev.score.";

/**
 * Kill timeout before launchd escalates SIGTERM to SIGKILL. Issue 4's shutdown
 * contract: must exceed one worst-case daemon phase, so a generous 600 s.
 */
export const EXIT_TIMEOUT_SECONDS = 600;

/** Seconds launchd waits before respawning after an unsuccessful exit. */
export const THROTTLE_INTERVAL_SECONDS = 10;

export function jobLabel(key: string): string {
  return `${LABEL_PREFIX}${key}`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Pure launchd job definition for one supervised daemon. `invocation` is issue
 * 2's managed contract rendered absolute: bun binary, entry script, then
 * `daemon --project <key> --managed`. `environment` is baked in because
 * launchd jobs get a bare PATH where gh/git/tmux don't resolve.
 */
export function renderPlist(
  project: ResolvedProject,
  invocation: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): string {
  const log = crashLogPath(project.key);
  const environmentBlock =
    Object.keys(environment).length === 0
      ? ""
      : `  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
  .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
  .join("\n")}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(jobLabel(project.key))}</string>
  <key>ProgramArguments</key>
  <array>
${invocation.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(project.mainLocation)}</string>
${environmentBlock}  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${THROTTLE_INTERVAL_SECONDS}</integer>
  <key>ExitTimeOut</key>
  <integer>${EXIT_TIMEOUT_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}
