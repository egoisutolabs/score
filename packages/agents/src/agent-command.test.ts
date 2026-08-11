import { encodeTmuxShellCommand } from "@score/agents/tmux.service";
import { agentArgv, agentConfigFromCommand, parseOpencodeModel } from "@score/shared/agent-command";
import type { AgentConfig } from "@score/shared/config/config.interface";
import { expect, test } from "vitest";

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

test("AGENT_CMD=opencode fails closed; the message stays claude-only", () => {
  expect(() => agentConfigFromCommand("opencode")).toThrow('"opencode"');
  try {
    agentConfigFromCommand("opencode");
    throw new Error("expected agentConfigFromCommand to throw");
  } catch (error) {
    expect((error as Error).message).not.toContain("opencode is");
    expect((error as Error).message).toMatch(/supported: claude$/);
  }
});

test("agentArgv throws for opencode — it never routes through the tmux seam", () => {
  expect(() => agentArgv({ harness: "opencode", model: "anthropic/claude-sonnet-5" }, "x")).toThrow(
    'unknown agent harness: "opencode"',
  );
});

test("parseOpencodeModel splits on the first slash", () => {
  expect(parseOpencodeModel("anthropic/claude-sonnet-5", "agent.model")).toEqual({
    providerID: "anthropic",
    modelID: "claude-sonnet-5",
  });
  expect(parseOpencodeModel("a/b/c", "agent.model")).toEqual({
    providerID: "a",
    modelID: "b/c",
  });
});

test.each(["sonnet", "/x", "x/"])("parseOpencodeModel rejects %j", (model) => {
  expect(() => parseOpencodeModel(model, "agent.model")).toThrow(
    /agent\.model must be "provider\/model"/,
  );
});
