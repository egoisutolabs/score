/**
 * Core owns the ports and domain phases. Implementations live in
 * @score/agents (AgentRuntime) and @score/tracker (WorkSource/ChangeHost);
 * GitService (adapters/) is the one in-core implementation, by exception.
 * Core never runs commands or talks to GitHub itself — ports do.
 */

export * from "./adapters/index";
export * from "./agent-runtime.interface";
export * from "./cleanup/index";
export * from "./daemon/index";
export * from "./dispatch/index";
export * from "./landing/index";
export * from "./maintenance/index";
export * from "./repair/index";
export * from "./supervisor/index";
export * from "./verify";
export * from "./workspace-driver.interface";
