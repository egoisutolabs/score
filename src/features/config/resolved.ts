import { readFile } from "node:fs/promises";
import { resolvedPath } from "@/features/config/layout";
import type { ResolvedProject } from "@/features/config/model";
import { configHash } from "@/features/config/resolve";
import { KNOWN_HARNESSES } from "@/shared/agent-command";
import {
  assertNoUnknownKeys,
  booleanValue,
  enumValue,
  objectValue,
  positiveIntegerValue,
  stringValue,
} from "@/shared/validation";

/**
 * Read a supervisor-written resolved.json. The file is hand-editable, so every
 * field is re-validated and the configHash re-checked against the resolved
 * values; any mismatch fails closed before the daemon constructs a phase.
 */
export async function readResolvedProject(
  key: string,
  path: string = resolvedPath(key),
): Promise<ResolvedProject> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(`no resolved config for '${key}' (${path}) — run: score up`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${detail}`);
  }
  const project = validateResolvedProject(parsed);
  if (project.key !== key) {
    throw new Error(`resolved.key is "${project.key}", expected "${key}" (${path})`);
  }
  const { configHash: stored, ...bare } = project;
  if (configHash(bare) !== stored) {
    throw new Error(
      `resolved.configHash does not match the resolved values in ${path} — hand-edited? run: score up`,
    );
  }
  return project;
}

export function validateResolvedProject(value: unknown): ResolvedProject {
  const path = "resolved";
  const record = objectValue(value, path);
  assertNoUnknownKeys(
    record,
    [
      "key",
      "mainLocation",
      "worktreeLocation",
      "githubRepo",
      "tickIntervalMs",
      "maxParallel",
      "agent",
      "autoMerge",
      "logRetentionDays",
      "configHash",
    ],
    path,
  );
  const agent = objectValue(record.agent, `${path}.agent`);
  assertNoUnknownKeys(agent, ["harness", "model"], `${path}.agent`);
  return {
    key: stringValue(record.key, `${path}.key`),
    mainLocation: stringValue(record.mainLocation, `${path}.mainLocation`),
    worktreeLocation: stringValue(record.worktreeLocation, `${path}.worktreeLocation`),
    githubRepo: stringValue(record.githubRepo, `${path}.githubRepo`),
    tickIntervalMs: positiveIntegerValue(record.tickIntervalMs, `${path}.tickIntervalMs`),
    maxParallel: positiveIntegerValue(record.maxParallel, `${path}.maxParallel`),
    agent: {
      harness: enumValue(agent.harness, KNOWN_HARNESSES, `${path}.agent.harness`),
      model: stringValue(agent.model, `${path}.agent.model`),
    },
    autoMerge: booleanValue(record.autoMerge, `${path}.autoMerge`),
    logRetentionDays: positiveIntegerValue(record.logRetentionDays, `${path}.logRetentionDays`),
    configHash: stringValue(record.configHash, `${path}.configHash`),
  };
}
