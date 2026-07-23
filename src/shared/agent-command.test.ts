import { expect, test } from "vitest";

import { encodeTmuxShellCommand } from "@/adapters/tmux";
import type { AgentConfig } from "@/features/config/model";
import { agentArgv, agentConfigFromCommand } from "@/shared/agent-command";

test("agentArgv pins the configured model and omits the flag without one", () => {
  expect(agentArgv({ harness: "claude", model: "opus-4.6" }, "do it")).toEqual([
    "claude",
    "--model",
    "opus-4.6",
    "do it",
  ]);
  expect(agentArgv({ harness: "claude" }, "do it")).toEqual(["claude", "do it"]);
});

test("an unknown harness fails closed, naming the value", () => {
  expect(() => agentArgv({ harness: "codex" } as unknown as AgentConfig, "x")).toThrow(
    'unknown agent harness: "codex"',
  );
});

test("agent argv survives tmux shell encoding with quotes in the prompt", () => {
  const argv = agentArgv({ harness: "claude", model: "opus-4.6" }, `don't "quote" me`);
  expect(encodeTmuxShellCommand(argv)).toBe(`'claude' '--model' 'opus-4.6' 'don'"'"'t "quote" me'`);
});

test("AGENT_CMD absence and bare claude keep working; anything else errors", () => {
  expect(agentConfigFromCommand(undefined)).toEqual({ harness: "claude" });
  expect(agentConfigFromCommand("")).toEqual({ harness: "claude" });
  expect(agentConfigFromCommand("claude")).toEqual({ harness: "claude" });
  expect(() => agentConfigFromCommand("codex exec")).toThrow('"codex exec"');
});
