import { readFile } from "node:fs/promises";
import { MANAGED_HARNESSES, parseOpencodeModel } from "@score/shared/agent-command";
import type { ResolvedProject } from "@score/shared/config/config.interface";
import { resolvedPath } from "@score/shared/config/layout";
import { configHash, DEFAULT_REVIEW_SETTLE_MS } from "@score/shared/config/resolve";
import {
  assertNoUnknownKeys,
  booleanValue,
  enumValue,
  objectValue,
  positiveIntegerValue,
  stringValue,
} from "@score/shared/validation";

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
  const { configHash: stored, reviewSettleMs, ...rest } = project;
  // A file written before reviewSettleMs existed was hashed without it; the
  // daemon must still start from it (a reboot after an upgrade comes before
  // the next `score up`), so the hash is re-checked over the shape on disk.
  const bare =
    (parsed as { reviewSettleMs?: unknown }).reviewSettleMs === undefined
      ? rest
      : { ...rest, reviewSettleMs };
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
      "reviewSettleMs",
      "logRetentionDays",
      "configHash",
    ],
    path,
  );
  const agent = objectValue(record.agent, `${path}.agent`);
  assertNoUnknownKeys(agent, ["harness", "model"], `${path}.agent`);
  const harness = enumValue(agent.harness, MANAGED_HARNESSES, `${path}.agent.harness`);
  const model = stringValue(agent.model, `${path}.agent.model`);
  if (harness === "opencode") parseOpencodeModel(model, `${path}.agent.model`);
  return {
    key: stringValue(record.key, `${path}.key`),
    mainLocation: stringValue(record.mainLocation, `${path}.mainLocation`),
    worktreeLocation: stringValue(record.worktreeLocation, `${path}.worktreeLocation`),
    githubRepo: stringValue(record.githubRepo, `${path}.githubRepo`),
    tickIntervalMs: positiveIntegerValue(record.tickIntervalMs, `${path}.tickIntervalMs`),
    maxParallel: positiveIntegerValue(record.maxParallel, `${path}.maxParallel`),
    agent: { harness, model },
    autoMerge: booleanValue(record.autoMerge, `${path}.autoMerge`),
    // Absent in files written before the field existed: the default, until
    // the next `score up` rewrites the file with it.
    reviewSettleMs:
      record.reviewSettleMs === undefined
        ? DEFAULT_REVIEW_SETTLE_MS
        : positiveIntegerValue(record.reviewSettleMs, `${path}.reviewSettleMs`),
    logRetentionDays: positiveIntegerValue(record.logRetentionDays, `${path}.logRetentionDays`),
    configHash: stringValue(record.configHash, `${path}.configHash`),
  };
}
