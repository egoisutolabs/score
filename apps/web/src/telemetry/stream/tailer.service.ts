/**
 * Shared per-project tailers (#82): one watch-plus-poll loop per project
 * wakes every attached subscription when either source dir changes.
 * `fs.watch` is a latency optimization only — correctness comes from the
 * subscriptions' own byte offsets plus the stat poll every
 * TAILER_POLL_INTERVAL_MS. No per-client watchers, no portability layer
 * beyond watch-plus-poll, by ceiling.
 */

import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";

/** Stat-poll cadence — a constant ceiling by definition (#82). */
export const TAILER_POLL_INTERVAL_MS = 2_000;

/** Both source dirs of the #77 segment layout. */
const SOURCE_DIRS = ["telemetry", "logs"] as const;

class ProjectTailer {
  private readonly subscribers = new Set<() => void>();
  private readonly watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private signature: string;

  constructor(private readonly projectDir: string) {
    this.signature = this.readSignature();
    for (const dir of SOURCE_DIRS) {
      try {
        this.watchers.push(watch(join(projectDir, dir), () => this.check()));
      } catch {
        // Dir absent (or unwatchable): the poll covers it, at poll latency.
      }
    }
    this.timer = setInterval(() => this.check(), TAILER_POLL_INTERVAL_MS);
  }

  attach(wake: () => void): void {
    this.subscribers.add(wake);
  }

  detach(wake: () => void): void {
    this.subscribers.delete(wake);
  }

  idle(): boolean {
    return this.subscribers.size === 0;
  }

  stop(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One shared stat pass; subscribers wake only when something changed. */
  private check(): void {
    const next = this.readSignature();
    if (next === this.signature) return;
    this.signature = next;
    for (const wake of [...this.subscribers]) wake();
  }

  // Names plus sizes across both source dirs: an append, a rotation, and a
  // deletion each change it. What changed is each subscriber's question,
  // answered from its own byte offsets.
  private readSignature(): string {
    const parts: string[] = [];
    for (const dir of SOURCE_DIRS) {
      let names: string[];
      try {
        names = readdirSync(join(this.projectDir, dir));
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        try {
          parts.push(`${dir}/${name}:${statSync(join(this.projectDir, dir, name)).size}`);
        } catch {
          // Deleted between readdir and stat — absent from this pass.
        }
      }
    }
    return parts.join("|");
  }
}

export class TailerRegistry {
  private readonly tailers = new Map<string, ProjectTailer>();

  /** Live tailer count — the shared-instance assertion's seam. */
  size(): number {
    return this.tailers.size;
  }

  /**
   * Attach a wake callback to the project's tailer, creating the loop on
   * first use. Returns the release; the last release stops the loop.
   */
  acquire(projectDir: string, wake: () => void): () => void {
    let tailer = this.tailers.get(projectDir);
    if (tailer === undefined) {
      tailer = new ProjectTailer(projectDir);
      this.tailers.set(projectDir, tailer);
    }
    const held = tailer;
    held.attach(wake);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.detach(wake);
      if (held.idle()) {
        held.stop();
        this.tailers.delete(projectDir);
      }
    };
  }
}

/** The process-wide registry: every route subscription shares these loops. */
export const defaultTailerRegistry = new TailerRegistry();
