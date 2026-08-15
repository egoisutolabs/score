/**
 * Tick telemetry (#54): mapping the typed phase results the daemon loop
 * already holds into correlated score.tick / score.phase spans and
 * score.*.decision events, plus the recorder that appends them as complete
 * single records. Owns shaping only — it never decides phase behavior, never
 * reads phase services, and never becomes a source of truth. Consumers:
 * daemon.run.ts at composition; tests in this folder.
 */
export * from "./telemetry.render";
export * from "./telemetry.service";
