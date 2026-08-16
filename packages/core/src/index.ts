/**
 * Core owns the ports and domain phases. Implementations of the agent,
 * workspace, and tracker ports live in @score/agents (AgentRuntime) and
 * @score/tracker (WorkSource/ChangeHost); among those, GitService (adapters/)
 * is the one in-core implementation, by exception. The supervisor/ adapters
 * (launchd, systemd) implement a port core itself owns, so they live here
 * by design, not exception.
 * Core never runs commands or talks to GitHub itself — ports do.
 */

export * from "./adapters/index";
export * from "./agent-runtime.interface";
export * from "./cleanup/index";
export * from "./daemon/index";
export * from "./dispatch/index";
export * from "./landing/index";
export * from "./maintenance/index";
export * from "./observation/index";
export * from "./repair/index";
export * from "./supervisor/index";
export * from "./verify";
export * from "./workspace-driver.interface";
