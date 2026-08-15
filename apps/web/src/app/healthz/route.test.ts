import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { GET } from "./route";

// Liveness must not touch the filesystem: SCORE_HOME points at a home that
// does not exist, and the probe answers anyway.
test("GET /healthz answers 200 without reading any state", async () => {
  vi.stubEnv("SCORE_HOME", join(await mkdtemp(join(tmpdir(), "score-healthz-")), "absent"));
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  vi.unstubAllEnvs();
});
