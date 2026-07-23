import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogTail } from "@/features/tui/tail";

// stat sizes can be inflated per-test to force the truncation race where the
// file shrinks between stat() and read(); everything else passes through.
const fsMock = vi.hoisted(() => ({ inflateStat: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: Parameters<typeof actual.stat>[0]) => {
      const result = await actual.stat(path);
      return { ...result, size: result.size + fsMock.inflateStat };
    },
  };
});

const DAY_ONE = new Date("2026-07-01T12:00:00.000Z");
const DAY_TWO = new Date("2026-07-02T00:00:05.000Z");

describe("LogTail", () => {
  let dir: string;
  let clock: Date;
  let tail: LogTail;

  const file = (date: Date) => join(dir, `${date.toISOString().slice(0, 10)}.log`);
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `line ${from + i}`);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "score-tail-"));
    clock = DAY_ONE;
    tail = new LogTail(dir, () => clock);
  });

  afterEach(() => {
    fsMock.inflateStat = 0;
    return rm(dir, { recursive: true, force: true });
  });

  it("reads the tail of today's file on first poll, capped at ~200 lines", async () => {
    await writeFile(file(DAY_ONE), `${lines(0, 300).join("\n")}\n`);
    await tail.poll();
    expect(tail.file).toBe("2026-07-01.log");
    expect(tail.lines.length).toBe(200);
    expect(tail.lines.at(-1)).toBe("line 299");
  });

  it("follows appended lines and keeps up with a 500-line append", async () => {
    await writeFile(file(DAY_ONE), "line 0\n");
    await tail.poll();
    await writeFile(file(DAY_ONE), `line 0\n${lines(1, 501).join("\n")}\n`);
    await tail.poll();
    expect(tail.lines.length).toBe(501);
    expect(tail.lines.at(-1)).toBe("line 500");
  });

  it("buffers a partial line until its newline arrives", async () => {
    await writeFile(file(DAY_ONE), "complete\npart");
    await tail.poll();
    expect([...tail.lines]).toEqual(["complete"]);
    await writeFile(file(DAY_ONE), "complete\npartial done\n");
    await tail.poll();
    expect([...tail.lines]).toEqual(["complete", "partial done"]);
  });

  it("caps memory at a 2000-line ring buffer", async () => {
    await writeFile(file(DAY_ONE), "line 0\n");
    await tail.poll();
    await writeFile(file(DAY_ONE), `line 0\n${lines(1, 2501).join("\n")}\n`);
    await tail.poll();
    expect(tail.lines.length).toBe(2000);
    expect(tail.lines[0]).toBe("line 501");
    expect(tail.lines.at(-1)).toBe("line 2500");
  });

  it("resets the offset when the file is truncated, without crashing", async () => {
    await writeFile(file(DAY_ONE), `${lines(0, 50).join("\n")}\n`);
    await tail.poll();
    await writeFile(file(DAY_ONE), "after truncate\n");
    await tail.poll();
    expect([...tail.lines]).toEqual(["after truncate"]);
  });

  it("switches to the new file when the date rolls", async () => {
    await writeFile(file(DAY_ONE), "old day\n");
    await tail.poll();
    clock = DAY_TWO;
    await writeFile(file(DAY_TWO), "new day\n");
    await tail.poll();
    expect(tail.file).toBe("2026-07-02.log");
    expect([...tail.lines]).toEqual(["new day"]);
  });

  it("resets on a short read instead of decoding NUL garbage", async () => {
    await writeFile(file(DAY_ONE), "line 0\n");
    await tail.poll();
    await writeFile(file(DAY_ONE), "line 0\nline 1\nline 2\n");
    // stat reports more bytes than the file holds by read time — the same
    // shape as truncation/recreation between stat() and read().
    fsMock.inflateStat = 10;
    await tail.poll();
    expect(tail.lines.some((line) => line.includes("\0"))).toBe(false);
    fsMock.inflateStat = 0;
    await tail.poll();
    expect([...tail.lines]).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("does not duplicate lines when polls overlap", async () => {
    await writeFile(file(DAY_ONE), "line 0\n");
    await tail.poll();
    await writeFile(file(DAY_ONE), "line 0\nline 1\nline 2\n");
    // Interval poll and keypress poll landing together must not both read
    // the same unread byte range.
    await Promise.all([tail.poll(), tail.poll(), tail.poll()]);
    expect([...tail.lines]).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("shows nothing when today's file does not exist yet", async () => {
    await tail.poll();
    expect(tail.lines.length).toBe(0);
    await writeFile(file(DAY_ONE), "born late\n");
    await tail.poll();
    expect([...tail.lines]).toEqual(["born late"]);
  });
});
