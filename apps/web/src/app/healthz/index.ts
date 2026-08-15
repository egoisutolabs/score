/**
 * The liveness probe: the process answers, nothing else. No file reads —
 * an unreadable Score home must never take down the probe whose whole job
 * is to say the app is up (readability is /readyz's job, not this one).
 */
export * from "./route";
