import {
  type SupervisorAdapter,
  supervisorForPlatform,
} from "@score/core/supervisor/supervisor-adapter.interface";
import { BunCommandRunner } from "@score/shared/adapters/command-runner.service";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { loadConfig } from "@score/shared/config/load";

/** What a fleet route needs per request: the live supervisor and the config. */
export interface FleetDeps {
  readonly adapter: SupervisorAdapter;
  /** null = present but unparseable; absence reads as an empty fleet. */
  readonly readConfig: () => Promise<ScoreConfig | null>;
  readonly now: () => Date;
}

// One adapter per process — the supervisor is a process-wide external, not a
// per-request resource. Lazy so importing this module on an unsupported
// platform (supervisorForPlatform throws) doesn't take the whole app down.
let adapter: SupervisorAdapter | null = null;

function platformAdapter(): SupervisorAdapter {
  adapter ??= supervisorForPlatform(new BunCommandRunner()).adapter;
  return adapter;
}

export function defaultFleetDeps(): FleetDeps {
  return {
    adapter: platformAdapter(),
    // Absence is an empty fleet, not an unreadable one (readyz's same
    // boundary); only a present-but-unparseable config degrades with a warning.
    readConfig: async () => {
      try {
        return await loadConfig();
      } catch (error) {
        return (error as { code?: string }).code === "ENOENT" ? { version: 1, projects: {} } : null;
      }
    },
    now: () => new Date(),
  };
}

let override: FleetDeps | null = null;

/**
 * Test seam: Next invokes route handlers with no composition point, so route
 * tests swap the deps here instead of shelling out to launchctl/systemctl.
 * Never called by production code.
 */
export function setFleetDeps(deps: FleetDeps | null): void {
  override = deps;
}

export function fleetDeps(): FleetDeps {
  return override ?? defaultFleetDeps();
}
