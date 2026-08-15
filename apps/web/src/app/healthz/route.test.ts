import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { assessReadiness } from "../../telemetry";
import { GET } from "./route";

// Liveness must not touch Score state: /healthz answers from the process
// alone, and the probe's whole value is staying up while the store burns.
// The mocks record every would-be state read (shared's config readers go
// through fs/promises#readFile; the telemetry feature's probe entry is
// asserted directly) — an ENOENT-swallowing regression cannot pass unnoticed.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("../../telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../telemetry")>();
  return { ...actual, assessReadiness: vi.fn(actual.assessReadiness) };
});

test("GET /healthz answers 200 without reading any Score state", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(vi.mocked(readFile)).not.toHaveBeenCalled();
  expect(assessReadiness).not.toHaveBeenCalled();
});

// SCORE_HOME points at a home that does not exist: the env is configured, so
// a regression that reads state only when set (then swallows the ENOENT)
// still trips the spies — the configured-path case is where such a read hides.
test("GET /healthz stays 200 with an absent SCORE_HOME, still reading nothing", async () => {
  vi.stubEnv("SCORE_HOME", join(await mkdtemp(join(tmpdir(), "score-healthz-")), "absent"));
  const response = await GET();
  expect(response.status).toBe(200);
  expect(vi.mocked(readFile)).not.toHaveBeenCalled();
  expect(assessReadiness).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
