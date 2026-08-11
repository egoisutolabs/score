import type { AgentConfig } from "@score/shared/config/config.interface";

/**
 * v1 harness enum (locked decision 7); jiti/module-path loading is a later epic.
 * Unmanaged-only (AGENT_CMD, agentArgv's tmux seam) — never merge this with
 * MANAGED_HARNESSES, or AGENT_CMD=opencode would silently pass in unmanaged
 * mode, where no server owner exists to run it.
 */
export const KNOWN_HARNESSES = ["claude"] as const;

/** Harnesses a managed project config may declare (locked decision 1). */
export const MANAGED_HARNESSES = ["claude", "opencode"] as const;

/** Split on the first "/", rejecting an empty provider or model half (locked decision 9). */
export function parseOpencodeModel(
  model: string,
  path: string,
): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `${path} must be "provider/model" for the opencode harness (got ${JSON.stringify(model)})`,
    );
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Guards the transitional gap between MANAGED_HARNESSES (config validation,
 * which already accepts "opencode") and KNOWN_HARNESSES (what the current
 * TmuxService-only wiring can actually dispatch). Callers use this to fail
 * before creating any state, not just before building a launch argv.
 */
export function assertKnownHarness(agent: Pick<AgentConfig, "harness">): void {
  if (!(KNOWN_HARNESSES as readonly string[]).includes(agent.harness)) {
    throw new Error(`unknown agent harness: ${JSON.stringify(agent.harness)}`);
  }
}

/**
 * The single seam turning agent config into a launch argv for both dispatch
 * and repair. Signature stability matters more than internals — the future
 * harness-adapter epic replaces the body, not the callers.
 */
export function agentArgv(agent: AgentConfig, prompt: string): readonly string[] {
  assertKnownHarness(agent);
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
