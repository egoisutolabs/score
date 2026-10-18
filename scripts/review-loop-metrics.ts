#!/usr/bin/env bun
/**
 * Online review-loop metrics from a project's telemetry segments:
 *
 *   bun scripts/review-loop-metrics.ts <project-key> [since YYYY-MM-DD]
 *
 * Reads ~/.score/projects/<key>/telemetry/*.jsonl (SCORE_HOME honored) and
 * prints the baseline table's figures per repair prompt version. Read-only.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderReviewLoopMetrics, reviewLoopMetrics } from "../apps/server/src/telemetry/metrics/review-loop.metrics";
import type { TelemetryRecord } from "../packages/core/src/telemetry/telemetry.interface";
import { GAP_RECORD_NAME } from "../packages/core/src/telemetry/telemetry-log.service";
import { telemetryDir } from "../packages/shared/src/config/layout";

const [key, since = "0000-00-00"] = process.argv.slice(2);
if (!key) {
  console.error("usage: bun scripts/review-loop-metrics.ts <project-key> [since YYYY-MM-DD]");
  process.exit(2);
}
const dir = telemetryDir(key);
// A project that never wrote telemetry is an empty dataset; a directory that
// exists but cannot be read is not, and a zero-record table for it would
// pass as "no activity". Only ENOENT is tolerated.
const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [] as string[];
  throw error;
});
const segments = names
  .filter((name) => name.endsWith(".jsonl") && name.slice(0, 10) >= since)
  .sort();
const records: TelemetryRecord[] = [];
let unparseable = 0;
for (const name of segments) {
  const text = await readFile(join(dir, name), "utf8");
  const lines = text.split("\n");
  // Only a final fragment without its newline is the append-only log's normal
  // state mid-write; a newline-terminated line that does not parse is a lost
  // record, which the canonical reader reports and this table must too.
  const tail = text.endsWith("\n") ? -1 : lines.length - 1;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as TelemetryRecord);
    } catch {
      if (index === tail) continue;
      unparseable += 1;
      console.error(`unparseable line ${index + 1} in ${name}`);
    }
  }
}
console.log(`${records.length} records from ${segments.length} segment(s) in ${dir}`);
if (unparseable > 0) {
  console.log(`WARNING: ${unparseable} unparseable line(s) skipped; the figures below are a floor`);
}
// Recovery writes a gap record for appends that were lost; a table over a
// log with gaps is incomplete, and must say so rather than look authoritative.
const gaps = records.filter((record) => record.name === GAP_RECORD_NAME);
if (gaps.length > 0) {
  const lost = gaps.reduce((sum, gap) => sum + Number(gap.attributes?.lost ?? 0), 0);
  console.log(
    `WARNING: ${gaps.length} telemetry gap(s) in this window, ${lost} record(s) lost; the figures below are a floor`,
  );
}
for (const line of renderReviewLoopMetrics(reviewLoopMetrics(records))) console.log(line);
