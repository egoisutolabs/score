/**
 * Readable-store probe behind GET /readyz: for every project under the score
 * home, resolved.json parses, and today's UTC telemetry segment — when it
 * exists — opens and its first complete line parses as JSON. Absence is
 * ready for telemetry only (a missing telemetry dir or today segment means
 * the daemon hasn't written yet) and for a missing projects dir (nothing set
 * up at all); a project dir without a parseable resolved.json is not a
 * readable store. Ceilings by
 * definition (#80): parse-only config check, first line only, no historical
 * scans, no file-type probing, no supervisor or GitHub calls.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { scoreHome } from "@score/shared/config/layout";
import type { WarningReason } from "./stream-envelope.interface";

export type ReadinessResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: WarningReason };

export class ReadinessService {
  constructor(
    private readonly projectsDir: string = join(scoreHome(), "projects"),
    private readonly now: () => Date = () => new Date(),
  ) {}

  check(): ReadinessResult {
    const projects = this.listProjects();
    // An enumeration failure (not absence) means no project's config can be
    // read at all — the store is not readable.
    if (projects === "UNREADABLE") return { ready: false, reason: "CONFIG_UNPARSEABLE" };
    for (const key of projects) {
      // Parse only — field validation is the daemon's concern, past this
      // probe's ceiling. Absent or unreadable both fail: a project dir
      // exists, so its config must parse; absence-is-ready covers telemetry.
      const config = read(join(this.projectsDir, key, "resolved.json"));
      if (config.kind !== "present" || !parses(config.text)) {
        return { ready: false, reason: "CONFIG_UNPARSEABLE" };
      }
      const stamp = this.now().toISOString().slice(0, 10);
      const probe = firstLine(join(this.projectsDir, key, "telemetry", `${stamp}.jsonl`));
      if (probe.kind === "unreadable" || (probe.kind === "line" && !parses(probe.text))) {
        return { ready: false, reason: "SEGMENT_UNREADABLE" };
      }
    }
    return { ready: true };
  }

  private listProjects(): string[] | "UNREADABLE" {
    try {
      return readdirSync(this.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      // No projects dir: the supervisor hasn't set anything up — ready.
      // Anything else (EACCES, ENOTDIR, …) is an unreadable store.
      return (error as { code?: string }).code === "ENOENT" ? [] : "UNREADABLE";
    }
  }
}

type ReadOutcome =
  | { readonly kind: "present"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

function read(path: string): ReadOutcome {
  try {
    return { kind: "present", text: readFileSync(path, "utf8") };
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
}

type FirstLineProbe =
  // "absent" and "no complete line yet" are both ready — nothing complete
  // exists to parse. Only "line" carries text to judge.
  | { readonly kind: "absent" | "no-line" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "line"; readonly text: string };

/**
 * Bytes before the segment's first newline, read chunk-by-chunk so a probe
 * never loads a whole day's history: memory and I/O are bounded by the first
 * line, whose length the single writer already bounds.
 */
function firstLine(path: string): FirstLineProbe {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
  try {
    const chunk = Buffer.alloc(65536);
    const parts: Buffer[] = [];
    for (;;) {
      const bytes = readSync(fd, chunk, 0, chunk.length, -1);
      if (bytes === 0) return { kind: "no-line" };
      const view = chunk.subarray(0, bytes);
      const newline = view.indexOf(0x0a);
      // Copy out of the reused chunk before the next readSync overwrites it.
      parts.push(Buffer.from(newline === -1 ? view : view.subarray(0, newline)));
      if (newline !== -1) return { kind: "line", text: Buffer.concat(parts).toString("utf8") };
    }
  } catch {
    // open() succeeding on a directory then read() failing lands here too.
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
