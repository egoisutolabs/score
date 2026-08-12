/**
 * Landing: gate, soak, and merge vetted heads into the default branch.
 * The only merge authority in the system. Never edits code, never talks
 * to agents; stages the exact observed SHA, never a branch name.
 */

export * from "./change.interface";
export * from "./change-host.interface";
export * from "./landing.policy";
export * from "./landing.render";
export * from "./landing.service";
