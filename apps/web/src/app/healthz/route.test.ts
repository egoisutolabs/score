import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

// spy:true keeps real implementations but records calls; the route is imported
// dynamically below so import-time reads are caught too, not just handler-time.
vi.mock("node:fs", { spy: true });
vi.mock("node:fs/promises", { spy: true });

const spiesIn = (mod: object) => Object.values(mod).filter((v) => vi.isMockFunction(v));

describe("GET /healthz", () => {
  it("returns 200 with zero fs calls at import or request time", async () => {
    vi.clearAllMocks();
    const route = await import("./route");
    const res = route.GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const spies = [...spiesIn(fs), ...spiesIn(fsp)];
    // Guards against the loop going vacuous if spy-mocking ever stops applying.
    expect(spies.length).toBeGreaterThan(0);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("runs on the node runtime, never statically", async () => {
    const route = await import("./route");
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
