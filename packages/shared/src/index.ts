/**
 * Shared: domain-independent utilities and contracts used by every package —
 * command running, config, validation, logging, legacy runtime discovery.
 * Nothing here may import from core, agents, or tracker.
 */

export * from "./adapters/index";
export * from "./agent-command";
export * from "./color";
export * from "./command.interface";
export * from "./command-runner.interface";
export * from "./config/index";
export * from "./file-log";
export * from "./legacy-runtime";
export * from "./log";
export * from "./validation";
