import { afterEach, expect, test } from "vitest";
import type { ResolvedProject } from "@/features/config/model";
import { jobLabel, renderPlist } from "@/features/supervisor/plist";

const originalScoreHome = process.env.SCORE_HOME;

afterEach(() => {
  if (originalScoreHome === undefined) delete process.env.SCORE_HOME;
  else process.env.SCORE_HOME = originalScoreHome;
});

const project: ResolvedProject = {
  key: "demo",
  mainLocation: "/Repos/My Project & Co <main>",
  worktreeLocation: "/wt/demo",
  githubRepo: "egoisutolabs/demo",
  tickIntervalMs: 5000,
  maxParallel: 1,
  agent: { harness: "claude", model: "claude-sonnet-5" },
  autoMerge: true,
  logRetentionDays: 30,
  configHash: "abc",
};

test("jobLabel namespaces keys", () => {
  expect(jobLabel("demo")).toBe("dev.score.demo");
});

test("renderPlist omits EnvironmentVariables when none are given", () => {
  process.env.SCORE_HOME = "/tmp/x";
  expect(renderPlist(project, ["/bin/bun"])).not.toContain("EnvironmentVariables");
});

test("renderPlist snapshot, XML-escaping paths with & and <>", () => {
  process.env.SCORE_HOME = "/tmp/score home & data";
  const invocation = [
    "/usr/local/bin/bun",
    "/opt/score & tools/dist/index.js",
    "daemon",
    "--project",
    "demo",
    "--managed",
  ];
  const environment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    SCORE_HOME: "/tmp/score home & data",
  };
  expect(renderPlist(project, invocation, environment)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.score.demo</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/bun</string>
    <string>/opt/score &amp; tools/dist/index.js</string>
    <string>daemon</string>
    <string>--project</string>
    <string>demo</string>
    <string>--managed</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Repos/My Project &amp; Co &lt;main&gt;</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>SCORE_HOME</key>
    <string>/tmp/score home &amp; data</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>600</integer>
  <key>StandardOutPath</key>
  <string>/tmp/score home &amp; data/projects/demo/launchd-crash.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/score home &amp; data/projects/demo/launchd-crash.log</string>
</dict>
</plist>
`);
});
