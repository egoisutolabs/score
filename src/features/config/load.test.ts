import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfig, validateScoreConfig } from "@/features/config/load";

const EXAMPLE_CONFIG = `// Score fleet configuration
{
  "version": 1, // schema version
  "log_retention_days": 30,
  "projects": {
    "score": {
      "enabled": true,
      "main_location": "~/Desktop/build-week/score",
      "worktree_location": "~/wt/score",
      "github_repo": "egoisutolabs/score",
      "config": {
        "tick_interval_ms": 60000,
        "max_parallel": 2,
        "agent": { "harness": "claude", "model": "claude-sonnet-5" },
        "auto_merge": true, // trailing comma next
      },
    },
  },
}
`;

function exampleValue(): unknown {
  return JSON.parse(
    JSON.stringify({
      version: 1,
      log_retention_days: 30,
      projects: {
        score: {
          enabled: true,
          main_location: "~/Desktop/build-week/score",
          worktree_location: "~/wt/score",
          github_repo: "egoisutolabs/score",
          config: {
            tick_interval_ms: 60000,
            max_parallel: 2,
            agent: { harness: "claude", model: "claude-sonnet-5" },
            auto_merge: true,
          },
        },
      },
    }),
  );
}

test("the example config (comments, trailing commas) loads from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-config-"));
  const path = join(dir, "config.jsonc");
  await writeFile(path, EXAMPLE_CONFIG);
  const config = await loadConfig(path);
  expect(config.projects.score?.main_location).toBe("~/Desktop/build-week/score");
  expect(config.log_retention_days).toBe(30);
});

test("invalid JSONC fails with the parse message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "score-config-"));
  const path = join(dir, "config.jsonc");
  await writeFile(path, "{ not json // comment\n");
  await expect(loadConfig(path)).rejects.toThrow(/config\.jsonc is not valid JSONC/);
});

test("unknown config field names the field and its path", () => {
  const value = exampleValue() as {
    projects: { score: { config: Record<string, unknown> } };
  };
  value.projects.score.config.tick_duration = value.projects.score.config.tick_interval_ms;
  delete value.projects.score.config.tick_interval_ms;
  expect(() => validateScoreConfig(value)).toThrow(/projects\.score\.config.*tick_duration/);
});

test("unknown top-level field fails", () => {
  const value = exampleValue() as Record<string, unknown>;
  value.retention = 5;
  expect(() => validateScoreConfig(value)).toThrow(/config has unknown fields: retention/);
});

test("unknown project field fails with its path", () => {
  const value = exampleValue() as { projects: { score: Record<string, unknown> } };
  value.projects.score.branch = "main";
  expect(() => validateScoreConfig(value)).toThrow(/projects\.score has unknown fields: branch/);
});

test("version !== 1 fails", () => {
  const value = exampleValue() as Record<string, unknown>;
  value.version = 2;
  expect(() => validateScoreConfig(value)).toThrow(/config\.version must be 1/);
});

test("project key with uppercase or underscore fails naming the charset", () => {
  const value = exampleValue() as { projects: Record<string, unknown> };
  value.projects.Score_Main = value.projects.score;
  delete value.projects.score;
  expect(() => validateScoreConfig(value)).toThrow(/"Score_Main" must match \[a-z0-9-\]/);
});

test("harness other than claude fails loudly", () => {
  const value = exampleValue() as {
    projects: { score: { config: { agent: { harness: string } } } };
  };
  value.projects.score.config.agent.harness = "codex";
  expect(() => validateScoreConfig(value)).toThrow(
    /projects\.score\.config\.agent\.harness must be one of claude/,
  );
});

test("wrong types fail with the field path", () => {
  const value = exampleValue() as {
    projects: { score: { enabled: unknown; config: { tick_interval_ms: unknown } } };
  };
  value.projects.score.enabled = "yes";
  expect(() => validateScoreConfig(value)).toThrow(/projects\.score\.enabled must be a boolean/);

  const again = exampleValue() as {
    projects: { score: { config: { tick_interval_ms: unknown } } };
  };
  again.projects.score.config.tick_interval_ms = -5;
  expect(() => validateScoreConfig(again)).toThrow(
    /projects\.score\.config\.tick_interval_ms must be a positive integer/,
  );
});

test("empty projects is valid", () => {
  expect(validateScoreConfig({ version: 1, projects: {} })).toEqual({
    version: 1,
    projects: {},
  });
});
