import { open, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_LINES = 2000;
const INITIAL_LINES = 200;
/** A huge existing file is entered near the end, not read in full. */
const INITIAL_READ_BYTES = 256 * 1024;

/**
 * Byte-offset tail over a daemon's dated log files (`logsDir/YYYY-MM-DD.log`,
 * UTC). poll() follows appends, resets when the file shrinks (truncation), and
 * switches files when the date rolls; the buffer is capped so a chatty daemon
 * can't grow the viewer unbounded.
 */
export class LogTail {
  #file = "";
  #offset = 0;
  #partial = "";
  #lines: string[] = [];

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Basename of the file currently tailed, for the pane title. */
  get file(): string {
    return this.#file;
  }

  get lines(): readonly string[] {
    return this.#lines;
  }

  async poll(): Promise<void> {
    const file = `${this.now().toISOString().slice(0, 10)}.log`;
    const fresh = file !== this.#file;
    if (fresh) {
      this.#file = file;
      this.#reset();
    }
    let size: number;
    try {
      size = (await stat(join(this.dir, file))).size;
    } catch {
      // Today's file doesn't exist (yet): nothing to show, offset stays 0.
      this.#reset();
      return;
    }
    if (size < this.#offset) this.#reset();
    let dropFirst = false;
    if (fresh && size > INITIAL_READ_BYTES) {
      this.#offset = size - INITIAL_READ_BYTES;
      dropFirst = true;
    }
    if (size === this.#offset) return;
    const buffer = Buffer.alloc(size - this.#offset);
    const handle = await open(join(this.dir, file), "r");
    try {
      await handle.read(buffer, 0, buffer.length, this.#offset);
    } finally {
      await handle.close();
    }
    this.#offset = size;
    const parts = (this.#partial + buffer.toString("utf8")).split("\n");
    this.#partial = parts.pop() ?? "";
    if (dropFirst) parts.shift();
    this.#lines.push(...parts);
    const cap = fresh ? INITIAL_LINES : MAX_LINES;
    if (this.#lines.length > cap) this.#lines.splice(0, this.#lines.length - cap);
  }

  #reset(): void {
    this.#offset = 0;
    this.#partial = "";
    this.#lines = [];
  }
}
