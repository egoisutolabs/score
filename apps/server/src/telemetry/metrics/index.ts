/**
 * Metrics: the online review-loop figures (rounds per PR, late-round
 * regression share, findings open at merge, parks by rule) computed from
 * the daemon's telemetry records, segmented by prompt version. Pure; it
 * reads nothing and decides nothing; the stream feature reads the segments.
 */

export * from "./review-loop.metrics";
