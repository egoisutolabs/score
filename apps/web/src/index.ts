/**
 * @score/web front door: the API-only loopback app that hosts the telemetry
 * probes and the v1 SSE wire. Owns wire shaping and read-only probes over
 * @score/core/@score/shared state; refuses UI, mutation, and any authority
 * over lifecycle (controls stay in the CLI).
 */
export * from "./telemetry";
