/**
 * Config: load/validate config.jsonc, resolve per-project runtime config,
 * read supervisor-written resolved.json, and own the ~/.score layout.
 * Interfaces + manual validation only — no schema DSL.
 */
export * from "./config.interface";
export * from "./jsonc";
export * from "./layout";
export * from "./load";
export * from "./resolve";
export * from "./resolved";
export * from "./template";
