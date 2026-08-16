/**
 * Telemetry: the versioned, OTel-shaped record vocabulary and its pure
 * validation policy — interfaces and decisions only, no I/O (that lands in
 * #77). Never an identity authority: subjects copy dispatch.identity.ts
 * values byte-identical; this feature never constructs, formats, or parses
 * a session or branch name.
 */

export * from "./telemetry.interface";
export * from "./telemetry.policy";
