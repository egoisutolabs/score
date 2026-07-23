import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ResolvedProject } from "@/features/config/model";
import { resolveProjects } from "@/features/config/resolve";
import { readResolvedProject, validateResolvedProject } from "@/features/config/resolved";

function fixtureProject(): ResolvedProject {
  const [resolved] = resolveProjects({
    version: 1,
    projects: {
      demo: {
        enabled: true,
        main_location: "/repos/demo",
        worktree_location: "/tmp/x/wt-demo",
        github_repo: "egoisutolabs/demo",
        config: {
          tick_interval_ms: 5000,
          max_parallel: 2,
          agent: { harness: "claude", model: "claude-sonnet-5" },
        },
      },
    },
  });
  if (!resolved) throw new Error("fixture did not resolve");
  return resolved;
}

async function writeFixture(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "score-resolved-"));
  const path = join(dir, "resolved.json");
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

test("a supervisor-written resolved.json reads back verbatim", async () => {
  const project = fixtureProject();
  const path = await writeFixture(project);
  expect(await readResolvedProject("demo", path)).toEqual(project);
});

test("missing resolved.json fails with the path and 'score up'", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "score-resolved-")), "resolved.json");
  await expect(readResolvedProject("demo", path)).rejects.toThrow(
    `no resolved config for 'demo' (${path}) — run: score up`,
  );
});

test("a missing field fails closed with the field path", async () => {
  const project: Record<string, unknown> = { ...fixtureProject() };
  delete project.mainLocation;
  const path = await writeFixture(project);
  await expect(readResolvedProject("demo", path)).rejects.toThrow(
    /resolved\.mainLocation must be a non-empty string/,
  );
});

test("a hand-edited value fails the configHash re-check", async () => {
  const project = { ...fixtureProject(), tickIntervalMs: 1000 };
  const path = await writeFixture(project);
  await expect(readResolvedProject("demo", path)).rejects.toThrow(
    /configHash does not match.*run: score up/,
  );
});

test("a resolved.json for a different key fails closed", async () => {
  const path = await writeFixture(fixtureProject());
  await expect(readResolvedProject("other", path)).rejects.toThrow(
    /resolved\.key is "demo", expected "other"/,
  );
});

test("invalid JSON fails with the parse message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-resolved-"));
  const path = join(dir, "resolved.json");
  await writeFile(path, "{ not json");
  await expect(readResolvedProject("demo", path)).rejects.toThrow(/is not valid JSON/);
});

test("unknown fields fail naming them", () => {
  expect(() => validateResolvedProject({ ...fixtureProject(), branch: "main" })).toThrow(
    /resolved has unknown fields: branch/,
  );
});
