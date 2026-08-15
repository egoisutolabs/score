import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScoreConfig } from "@score/shared/config/config.interface";
import { resolveProjects } from "@score/shared/config/resolve";
import { expect, test, vi } from "vitest";
import { GET } from "./route";

async function readableHome(): Promise<string> {
  const config: ScoreConfig = {
    version: 1,
    projects: {
      demo: {
        enabled: true,
        main_location: "/repos/demo",
        worktree_location: "/tmp/wt-demo",
        github_repo: "egoisutolabs/demo",
        config: { agent: { harness: "claude", model: "claude-sonnet-5" } },
      },
    },
  };
  const home = await mkdtemp(join(tmpdir(), "score-readyz-route-"));
  await writeFile(join(home, "config.jsonc"), JSON.stringify(config), "utf8");
  const [resolved] = resolveProjects(config);
  if (!resolved) throw new Error("fixture did not resolve");
  const projectDir = join(home, "projects", resolved.key);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "resolved.json"), JSON.stringify(resolved), "utf8");
  return home;
}

test("GET /readyz answers 200 when config and telemetry are readable", async () => {
  vi.stubEnv("SCORE_HOME", await readableHome());
  const response = await GET();
  expect(response.status).toBe(200);
  expect((await response.json()).ready).toBe(true);
  vi.unstubAllEnvs();
});

test("GET /readyz answers 503 with the reason code when the config is unreadable", async () => {
  vi.stubEnv("SCORE_HOME", join(await mkdtemp(join(tmpdir(), "score-readyz-route-")), "absent"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    ready: false,
    checks: [{ name: "config", ready: false, reason_code: "config-unreadable" }],
  });
  vi.unstubAllEnvs();
});
