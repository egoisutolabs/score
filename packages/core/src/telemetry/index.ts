/**
 * Telemetry: the versioned, OTel-shaped record vocabulary, its pure
 * validation policy, and the append-only dated JSONL log (one daemon
 * appends, any reader tails without coordination). Never an identity
 * authority: subjects copy dispatch.identity.ts values byte-identical; this
 * feature never constructs, formats, or parses a session or branch name.
 * Never authoritative: phases never read telemetry back as current truth.
 */

export * from "./telemetry.interface";
export * from "./telemetry.policy";
export * from "./telemetry-log.service";
