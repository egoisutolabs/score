import { readFile } from "node:fs/promises";
import { MANAGED_HARNESSES, parseOpencodeModel } from "@score/shared/agent-command";
import type {
  ProjectConfig,
  ProjectRuntimeConfig,
  ScoreConfig,
} from "@score/shared/config/config.interface";
import { parseJsonc } from "@score/shared/config/jsonc";
import { configPath } from "@score/shared/config/layout";
import {
  assertNoUnknownKeys,
  booleanValue,
  enumValue,
  objectValue,
  positiveIntegerValue,
  stringValue,
} from "@score/shared/validation";

export const PROJECT_KEY_PATTERN = /^[a-z0-9-]+$/;

export async function loadConfig(path: string = configPath()): Promise<ScoreConfig> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`config.jsonc is not valid JSONC: ${detail}`);
  }
  return validateScoreConfig(parsed);
}

export function validateScoreConfig(value: unknown): ScoreConfig {
  const root = objectValue(value, "config");
  assertNoUnknownKeys(root, ["version", "log_retention_days", "projects"], "config");
  if (root.version !== 1) throw new Error("config.version must be 1");
  if (root.log_retention_days !== undefined) {
    positiveIntegerValue(root.log_retention_days, "config.log_retention_days");
  }
  const projectsValue = objectValue(root.projects, "projects");
  const projects: Record<string, ProjectConfig> = {};
  for (const [key, project] of Object.entries(projectsValue)) {
    if (!PROJECT_KEY_PATTERN.test(key)) {
      throw new Error(`projects key "${key}" must match [a-z0-9-]`);
    }
    projects[key] = validateProject(project, `projects.${key}`);
  }
  return {
    version: 1,
    ...(root.log_retention_days !== undefined && {
      log_retention_days: root.log_retention_days as number,
    }),
    projects,
  };
}

function validateProject(value: unknown, path: string): ProjectConfig {
  const project = objectValue(value, path);
  assertNoUnknownKeys(
    project,
    ["enabled", "main_location", "worktree_location", "github_repo", "config"],
    path,
  );
  return {
    enabled: booleanValue(project.enabled, `${path}.enabled`),
    main_location: stringValue(project.main_location, `${path}.main_location`),
    worktree_location: stringValue(project.worktree_location, `${path}.worktree_location`),
    github_repo: stringValue(project.github_repo, `${path}.github_repo`),
    config: validateRuntimeConfig(project.config, `${path}.config`),
  };
}

function validateRuntimeConfig(value: unknown, path: string): ProjectRuntimeConfig {
  const config = objectValue(value, path);
  assertNoUnknownKeys(config, ["tick_interval_ms", "max_parallel", "agent", "auto_merge"], path);
  const agent = objectValue(config.agent, `${path}.agent`);
  assertNoUnknownKeys(agent, ["harness", "model"], `${path}.agent`);
  const harness = enumValue(agent.harness, MANAGED_HARNESSES, `${path}.agent.harness`);
  const model = stringValue(agent.model, `${path}.agent.model`);
  if (harness === "opencode") parseOpencodeModel(model, `${path}.agent.model`);
  return {
    ...(config.tick_interval_ms !== undefined && {
      tick_interval_ms: positiveIntegerValue(config.tick_interval_ms, `${path}.tick_interval_ms`),
    }),
    ...(config.max_parallel !== undefined && {
      max_parallel: positiveIntegerValue(config.max_parallel, `${path}.max_parallel`),
    }),
    agent: { harness, model },
    ...(config.auto_merge !== undefined && {
      auto_merge: booleanValue(config.auto_merge, `${path}.auto_merge`),
    }),
  };
}
