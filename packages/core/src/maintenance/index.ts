/**
 * Maintenance: the legacy cleanup-then-dispatch composition run as one
 * tick. Thin; exists to preserve the legacy pass shape. Owns only the
 * ordering — every cleanup and dispatch decision belongs to those
 * features' own policies.
 */
export * from "./maintenance.render";
export * from "./maintenance.service";
