/**
 * Core owns the ports and domain phases. Implementations live in
 * @score/agents (AgentRuntime) and @score/tracker (WorkSource/ChangeHost);
 * GitService (adapters/) is the one in-core implementation, by exception.
 */
export * from "./agent-runtime.interface";
export * from "./verify";
export * from "./workspace-driver.interface";
