import type { AgentConfig } from "@/features/config/model";

/** v1 harness enum (locked decision 7); jiti/module-path loading is a later epic. */
export const KNOWN_HARNESSES = ["claude"] as const;

/**
 * The single seam turning agent config into a launch argv for both dispatch
 * and repair. Signature stability matters more than internals — the future
 * harness-adapter epic replaces the body, not the callers.
 */
export function agentArgv(agent: AgentConfig, prompt: string): readonly string[] {
  if (agent.harness !== "claude") {
    throw new Error(`unknown agent harness: ${JSON.stringify(agent.harness)}`);
  }
  return agent.model === undefined
    ? ["claude", prompt]
    : ["claude", "--model", agent.model, prompt];
}

/** Legacy AGENT_CMD env: absence or a bare harness name means claude, no model pin. */
export function agentConfigFromCommand(command: string | undefined): AgentConfig {
  const harness = command || "claude";
  if (harness !== "claude") {
    throw new Error(
      `AGENT_CMD must name a known harness (got ${JSON.stringify(command)}); supported: ${KNOWN_HARNESSES.join(", ")}`,
    );
  }
  return { harness };
}
