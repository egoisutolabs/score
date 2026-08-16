import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tailPoll } from "./tail.service";

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

describe("tailPoll", () => {
  let dir: string;
  let clock: Date;

  const poll = (cursor: string | null = null) => tailPoll(dir, cursor, () => clock);
  const file = (date: Date) => join(dir, `${date.toISOString().slice(0, 10)}.log`);
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `line ${from + i}`);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "score-tail-"));
    clock = DAY_ONE;
  });

  afterEach(() => {
    fsMock.inflateStat = 0;
    return rm(dir, { recursive: true, force: true });
  });

  it("reads the tail of today's file on first poll, capped at ~200 lines", async () => {
    await writeFile(file(DAY_ONE), `${lines(0, 300).join("\n")}\n`);
    const window = await poll();
    expect(window.file).toBe("2026-07-01.log");
    expect(window.reset).toBe(false);
    expect(window.lines.length).toBe(200);
    expect(window.lines.at(-1)).toBe("line 299");
  });

  it("follows appended lines from the echoed cursor", async () => {
    await writeFile(file(DAY_ONE), "line 0\n");
    const first = await poll();
    await writeFile(file(DAY_ONE), `line 0\n${lines(1, 401).join("\n")}\n`);
    const second = await poll(first.cursor);
    expect(second.reset).toBe(false);
    expect(second.lines.length).toBe(400);
    expect(second.lines[0]).toBe("line 1");
    expect(second.lines.at(-1)).toBe("line 400");
  });

  it("holds a partial line back until its newline arrives", async () => {
    await writeFile(file(DAY_ONE), "complete\npart");
    const first = await poll();
    expect([...first.lines]).toEqual(["complete"]);
    await writeFile(file(DAY_ONE), "complete\npartial done\n");
    const second = await poll(first.cursor);
    expect([...second.lines]).toEqual(["partial done"]);
  });

  it("caps a follow burst per response and pages the rest via the cursor", async () => {
    await writeFile(file(DAY_ONE), "line 0\n");
    const first = await poll();
    await writeFile(file(DAY_ONE), `line 0\n${lines(1, 1202).join("\n")}\n`);
    const second = await poll(first.cursor);
    expect(second.lines.length).toBe(500);
    expect(second.lines[0]).toBe("line 1");
    expect(second.lines.at(-1)).toBe("line 500");
    // Nothing lost: the next polls continue exactly where the cap stopped.
    const third = await poll(second.cursor);
    expect(third.lines[0]).toBe("line 501");
    expect(third.lines.at(-1)).toBe("line 1000");
    const fourth = await poll(third.cursor);
    expect(fourth.lines[0]).toBe("line 1001");
    expect(fourth.lines.at(-1)).toBe("line 1201");
  });

  it("resets when the file is truncated, without crashing", async () => {
    await writeFile(file(DAY_ONE), `${lines(0, 50).join("\n")}\n`);
    const first = await poll();
    await writeFile(file(DAY_ONE), "after truncate\n");
    const second = await poll(first.cursor);
    expect(second.reset).toBe(true);
    expect([...second.lines]).toEqual(["after truncate"]);
  });

  it("switches to the new file when the date rolls", async () => {
    await writeFile(file(DAY_ONE), "old day\n");
    const first = await poll();
    clock = DAY_TWO;
    await writeFile(file(DAY_TWO), "new day\n");
    const second = await poll(first.cursor);
    expect(second.file).toBe("2026-07-02.log");
    expect(second.reset).toBe(true);
    expect([...second.lines]).toEqual(["new day"]);
  });

  it("resets on a short read instead of decoding NUL garbage", async () => {
    await writeFile(file(DAY_ONE), "line 0\n");
    const first = await poll();
    await writeFile(file(DAY_ONE), "line 0\nline 1\nline 2\n");
    // stat reports more bytes than the file holds by read time — the same
    // shape as truncation/recreation between stat() and read().
    fsMock.inflateStat = 10;
    const second = await poll(first.cursor);
    expect(second.reset).toBe(true);
    expect(second.lines.some((line) => line.includes("\0"))).toBe(false);
    fsMock.inflateStat = 0;
    const third = await poll(second.cursor);
    expect([...third.lines]).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("shows nothing when today's file does not exist yet", async () => {
    const first = await poll();
    expect(first.lines.length).toBe(0);
    expect(first.reset).toBe(false);
    await writeFile(file(DAY_ONE), "born late\n");
    const second = await poll(first.cursor);
    expect([...second.lines]).toEqual(["born late"]);
  });

  it("degrades an undecodable cursor to a fresh tail", async () => {
    await writeFile(file(DAY_ONE), "line 0\nline 1\n");
    const window = await poll("not-a-cursor");
    expect(window.reset).toBe(true);
    expect([...window.lines]).toEqual(["line 0", "line 1"]);
  });

  it("resets when the file is deleted mid-day under a live cursor", async () => {
    await writeFile(file(DAY_ONE), "a\nb\nc\n");
    const first = await poll();
    await rm(file(DAY_ONE));
    const gone = await poll(first.cursor);
    // Deletion must present as a reset — a silent offset-0 cursor would make
    // the client append the recreated file's content after its stale buffer.
    expect(gone.reset).toBe(true);
    expect(gone.lines.length).toBe(0);
    await writeFile(file(DAY_ONE), "reborn\n");
    const second = await poll(gone.cursor);
    expect([...second.lines]).toEqual(["reborn"]);
  });

  it("forces progress through a line bigger than the read window", async () => {
    await writeFile(file(DAY_ONE), "small\n");
    const first = await poll();
    // 300KB with no newline, then a normal line: the window (256KB) can never
    // contain the newline from the stuck offset, so the tail must chunk
    // through instead of wedging forever.
    const huge = "x".repeat(300 * 1024);
    await writeFile(file(DAY_ONE), `small\n${huge}\nafter\n`);
    const second = await poll(first.cursor);
    expect(second.lines.length).toBe(1);
    expect(second.lines[0]?.length).toBe(256 * 1024);
    const third = await poll(second.cursor);
    expect(third.lines.at(-1)).toBe("after");
    expect(third.lines[0]?.endsWith("x")).toBe(true);
  });

  it("keeps the cursor byte-exact when a poll lands mid-multibyte character", async () => {
    await writeFile(file(DAY_ONE), "prev\n");
    const first = await poll();
    // Writer flushed "abc" plus the first byte of a 3-byte "…": deriving the
    // offset from decoded text would re-encode the replacement char (3 bytes)
    // and walk the cursor back into the already-delivered "prev" line.
    await writeFile(file(DAY_ONE), Buffer.concat([Buffer.from("prev\nabc"), Buffer.from([0xe2])]));
    const second = await poll(first.cursor);
    expect(second.lines.length).toBe(0);
    await writeFile(file(DAY_ONE), "prev\nabc…def\nnext\n");
    const third = await poll(second.cursor);
    expect([...third.lines]).toEqual(["abc…def", "next"]);
  });
});
