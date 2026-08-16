import { open, stat } from "node:fs/promises";
import { join } from "node:path";

/** A huge existing file is entered near the end, not read in full. */
const INITIAL_READ_BYTES = 256 * 1024;
const INITIAL_LINES = 200;
/**
 * Per-response caps: a huge append burst pages across polls via the cursor
 * instead of wedging the route with one unbounded response.
 */
const MAX_READ_BYTES = 256 * 1024;
const MAX_LINES = 500;

/** One poll's window over the dated log; `cursor` is echoed back next call. */
export interface TailWindow {
  readonly file: string;
  readonly lines: readonly string[];
  readonly cursor: string;
  /** True when the window restarted (rotation, truncation, unusable cursor). */
  readonly reset: boolean;
}

/**
 * The cursor is opaque to clients but self-describing to the server: the
 * dated file plus the byte offset of the next unread line. No partial-line
 * text travels in it — the offset only ever advances past complete lines, so
 * a line split across polls is re-read whole once its newline lands.
 */
interface TailCursor {
  readonly file: string;
  readonly offset: number;
}

function encodeCursor(cursor: TailCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(token: string): TailCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const raw = parsed as { file?: unknown; offset?: unknown };
    if (
      typeof raw.file === "string" &&
      /^\d{4}-\d{2}-\d{2}\.log$/.test(raw.file) &&
      typeof raw.offset === "number" &&
      Number.isInteger(raw.offset) &&
      raw.offset >= 0
    ) {
      return { file: raw.file, offset: raw.offset };
    }
  } catch {
    // Garbage or truncated token — degrade to a fresh tail, never an error.
  }
  return null;
}

/**
 * Stateless byte-offset tail over a daemon's dated log files
 * (`dir/YYYY-MM-DD.log`, UTC): each call re-opens from the presented cursor,
 * so the server holds no per-client state. Follows appends, resets when the
 * file shrinks (truncation) or the date rolls, and degrades an invalid or
 * stale cursor to a fresh tail — a poll can warn, never crash.
 */
export async function tailPoll(
  dir: string,
  token: string | null,
  now: () => Date = () => new Date(),
): Promise<TailWindow> {
  const file = `${now().toISOString().slice(0, 10)}.log`;
  const presented = token === null ? null : decodeCursor(token);
  const continued = presented !== null && presented.file === file;
  // A presented-but-unusable cursor (garbage, or yesterday's file) means the
  // client's window did not survive; a first call without a cursor is not a
  // reset, it is the window being born.
  let reset = token !== null && !continued;
  let offset = continued ? presented.offset : -1;

  let size: number;
  try {
    size = (await stat(join(dir, file))).size;
  } catch {
    // Today's file doesn't exist (yet): nothing to show, offset stays 0.
    return { file, lines: [], cursor: encodeCursor({ file, offset: 0 }), reset };
  }
  if (offset > size) {
    // The file shrank below the cursor: truncation/recreation — re-enter fresh.
    reset = true;
    offset = -1;
  }
  const fresh = offset === -1;
  if (fresh) offset = size > INITIAL_READ_BYTES ? size - INITIAL_READ_BYTES : 0;
  // Entering mid-file lands inside a line; the first split piece is a
  // fragment, not a line, so it is dropped (its bytes still count as read).
  const dropFirst = fresh && offset > 0;
  const length = Math.min(size - offset, fresh ? INITIAL_READ_BYTES : MAX_READ_BYTES);
  if (length === 0) return { file, lines: [], cursor: encodeCursor({ file, offset }), reset };

  const buffer = Buffer.alloc(length);
  let bytesRead: number;
  try {
    const handle = await open(join(dir, file), "r");
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, offset));
    } finally {
      await handle.close();
    }
  } catch {
    // The file vanished between stat and open (rotation/deletion race):
    // reset and let the next poll read whatever replaced it.
    return { file, lines: [], cursor: encodeCursor({ file, offset: 0 }), reset: true };
  }
  if (bytesRead < length) {
    // The file shrank between stat and read (truncation/recreation race):
    // decoding the zero-filled remainder would inject NUL garbage and skip
    // the new contents. Reset and let the next poll read the real file.
    return { file, lines: [], cursor: encodeCursor({ file, offset: 0 }), reset: true };
  }

  const parts = buffer.toString("utf8").split("\n");
  const partial = parts.pop() ?? "";
  if (dropFirst) parts.shift();
  // Everything before the trailing partial line was consumed — including a
  // dropped entry fragment and, on a fresh window, lines skipped by the cap.
  let consumed = length - Buffer.byteLength(partial, "utf8");
  let lines = parts;
  if (fresh && parts.length > INITIAL_LINES) {
    lines = parts.slice(parts.length - INITIAL_LINES);
  } else if (!fresh && parts.length > MAX_LINES) {
    // A follow burst pages oldest-first: return the first cap's worth and
    // advance the cursor only past what was returned, so nothing is lost.
    lines = parts.slice(0, MAX_LINES);
    consumed = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
  }
  return { file, lines, cursor: encodeCursor({ file, offset: offset + consumed }), reset };
}
