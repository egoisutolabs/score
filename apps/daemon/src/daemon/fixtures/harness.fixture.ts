// Shared loop-test harness: the fake runner, capture logger, managed-home
// builder, and canned gh/git/tmux responses the daemon loop tests drive
// runDaemonLoop with. One copy so the run tests and the telemetry tests
// cannot drift apart.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkIdentity } from "@score/core/dispatch/dispatch.identity";
import type { CommandResult } from "@score/shared/command.interface";
import type { CommandRunner, RunCommandOptions } from "@score/shared/command-runner.interface";
import type { AgentConfig, ScoreConfig } from "@score/shared/config/config.interface";
import { resolveProjects } from "@score/shared/config/resolve";
import type { Logger, LogLine } from "@score/shared/log";

export interface FakeResponse {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type FakeResponder = (command: readonly string[]) => FakeResponse;

export interface FakeRunnerCall {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly mutates: boolean | undefined;
  readonly dryRun: boolean | undefined;
}

export class FakeRunner implements CommandRunner {
  readonly calls: FakeRunnerCall[] = [];

  constructor(private readonly respond: FakeResponder = () => ({})) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({
      command: [...command],
      cwd: options.cwd,
      mutates: options.mutates,
      dryRun: options.dryRun,
    });
    const response = this.respond(command);
    return {
      command,
      cwd: options.cwd,
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      timedOut: false,
      dryRun: false,
    };
  }
}

export class CaptureLogger implements Logger {
  readonly logged: LogLine[] = [];
  info(text: string): void {
    this.logged.push({ level: "info", text });
  }
  warn(text: string): void {
    this.logged.push({ level: "warn", text });
  }
  debug(text: string): void {
    this.logged.push({ level: "debug", text });
  }
  lines(lines: readonly LogLine[]): void {
    this.logged.push(...lines);
  }
}

/** Writes a valid resolved.json for `demo` under a temp SCORE_HOME and returns both dirs. */
export async function managedFixture(
  mainLocation: string,
  agent: AgentConfig = { harness: "claude", model: "claude-sonnet-5" },
  tickIntervalMs = 5000,
): Promise<{ home: string; worktree: string }> {
  const home = await mkdtemp(join(tmpdir(), "score-home-"));
  const worktree = join(home, "wt-demo");
  const config: ScoreConfig = {
    version: 1,
    projects: {
      demo: {
        enabled: true,
        main_location: mainLocation,
        worktree_location: worktree,
        github_repo: "egoisutolabs/demo",
        config: {
          tick_interval_ms: tickIntervalMs,
          max_parallel: 2,
          agent,
        },
      },
    },
  };
  const [project] = resolveProjects(config);
  await mkdir(join(home, "projects", "demo"), { recursive: true });
  await writeFile(join(home, "projects", "demo", "resolved.json"), JSON.stringify(project));
  return { home, worktree };
}

export function managedResponses(repo: string): FakeResponder {
  return (command) => {
    if (command[1] === "rev-parse" && command.includes("--abbrev-ref")) {
      return { stdout: "origin/develop\n" };
    }
    if (command[1] === "rev-parse") return { stdout: `${repo}\n` };
    if (command[1] === "remote") return { stdout: "git@github.com:egoisutolabs/demo.git\n" };
    if (command[1] === "config") return { exitCode: 1 };
    if (command[1] === "repo") return { stdout: '{"nameWithOwner":"egoisutolabs/demo"}\n' };
    // No tmux server running yet: the env scrub fails and that must be fine.
    if (command[1] === "set-environment") return { exitCode: 1 };
    if (command[1] === "symbolic-ref") return { stdout: "refs/remotes/origin/develop\n" };
    return {};
  };
}

export const SEEDED_ISSUE_NUMBER = 7;
export const SEEDED_ISSUE_TITLE = "Demo issue";

/**
 * The seeded issue's worktree branch. Derived from the identity authority —
 * a fixture module is production-shaped source, so boundary.test.ts's
 * no-shape-literals rule applies to it exactly as to any non-test file.
 */
export function seededIssueBranch(workspaceRoot = "/workspace"): string {
  return createWorkIdentity(
    workspaceRoot,
    {
      number: SEEDED_ISSUE_NUMBER,
      title: SEEDED_ISSUE_TITLE,
      body: "",
      labels: [],
      state: "OPEN",
      stateReason: null,
      url: `https://github.com/egoisutolabs/demo/issues/${SEEDED_ISSUE_NUMBER}`,
      comments: [],
    },
    "demo",
  ).branch;
}

/**
 * Same git/gh proofs as managedResponses, plus one real open, dispatchable
 * issue and empty PR lists. A real candidate forces dispatch (not just
 * repair's unconditional listSessions) through the shared AgentRuntime, and
 * lets a dry-run test prove suppression against a call that would otherwise
 * happen — a candidate-free backlog can't tell either apart. Harness-agnostic;
 * the claude loop also needs #64's confirmed-absent tmux stderr, which the
 * opencode adapter never asks for.
 */
export function managedResponsesSeeded(repo: string): FakeResponder {
  const base = managedResponses(repo);
  const issueJson = JSON.stringify({
    number: SEEDED_ISSUE_NUMBER,
    title: SEEDED_ISSUE_TITLE,
    body: "",
    // isOpenChildIssue requires an eligibleLabelPrefix match (default "epic:").
    labels: [{ name: "epic:demo" }],
    state: "OPEN",
    stateReason: null,
    url: `https://github.com/egoisutolabs/demo/issues/${SEEDED_ISSUE_NUMBER}`,
  });
  return (command) => {
    if (command[0] === "gh" && command[1] === "issue" && command[2] === "list") {
      return { stdout: `[${issueJson}]\n` };
    }
    if (command[0] === "gh" && command[1] === "issue") return { stdout: `${issueJson}\n` };
    if (command[0] === "gh" && command[1] === "pr") return { stdout: "[]\n" };
    // #64's fail-closed sessionExists: exit 1 alone is not absence — tmux's
    // own "can't find session" stderr is what confirms the session is gone.
    if (command[1] === "has-session") return { exitCode: 1, stderr: "can't find session\n" };
    return base(command);
  };
}
