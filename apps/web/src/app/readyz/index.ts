/**
 * The readiness probe: config and the selected telemetry segments are
 * readable, or the response names the failing check with a reason code.
 * A thin parser over src/telemetry's assessReadiness — no probing logic
 * lives in the route file.
 */
export * from "./route";
