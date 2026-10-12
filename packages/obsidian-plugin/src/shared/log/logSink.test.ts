import { describe, expect, test } from "bun:test";
import {
  FAILURE_PAUSE_MS,
  LOG_FILE_NAME,
  MAX_FILE_BYTES,
  PENDING_ENTRY_LIMIT,
  ROTATED_FILE_COUNT,
  createLogSink,
  logFilePaths,
  type LogFs,
  type LogSinkOptions,
} from "./logSink";
import { createMemoryLogFs } from "./memoryLogFs";

const DIR = "/mem/plugins/mcp";
const WARN_PREFIX = "MCP Connector: the diagnostic log cannot be written";

const currentPath = `${DIR}/diagnostic.log`;
const rotatedPath = (n: number) => `${DIR}/diagnostic.${n}.log`;

/** A 30-byte line, unique per index: `NN` then padding then a newline. */
function line30(i: number): string {
  return `${String(i).padStart(2, "0")}${"x".repeat(27)}\n`;
}

/** Oldest file first: `.4` … `.1`, then the current one. */
function readAll(fs: { files: Map<string, string> }): string {
  let out = "";
  for (let n = ROTATED_FILE_COUNT; n >= 1; n -= 1) {
    out += fs.files.get(rotatedPath(n)) ?? "";
  }
  return out + (fs.files.get(currentPath) ?? "");
}

function setup(opts?: {
  maxFileBytes?: number;
  failWrites?: () => boolean;
  onResume?: LogSinkOptions["onResume"];
}) {
  const memory = createMemoryLogFs({ failWrites: opts?.failWrites });
  const clock = { now: 1_000_000 };
  const warns: string[] = [];
  const appendCalls = { count: 0 };
  // A wrapper that counts appendFile attempts; every other method is the
  // memory file system's own.
  const fs: LogFs = {
    ...memory,
    appendFile: (path, data) => {
      appendCalls.count += 1;
      return memory.appendFile(path, data);
    },
  };
  const sink = createLogSink({
    dir: DIR,
    fs,
    now: () => clock.now,
    warn: (m) => warns.push(m),
    onResume: opts?.onResume,
    maxFileBytes: opts?.maxFileBytes,
  });
  return { sink, memory, clock, warns, appendCalls };
}

describe("log sink constants and paths", () => {
  test("the bounds are the documented ones", () => {
    expect(LOG_FILE_NAME).toBe("diagnostic.log");
    expect(ROTATED_FILE_COUNT).toBe(4);
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(FAILURE_PAUSE_MS).toBe(30_000);
    expect(PENDING_ENTRY_LIMIT).toBe(1_000);
  });

  test("logFilePaths lists the current file then .1 to .4, joined by the given fs", () => {
    const fs = createMemoryLogFs();
    expect(logFilePaths(DIR, fs)).toEqual([
      currentPath,
      rotatedPath(1),
      rotatedPath(2),
      rotatedPath(3),
      rotatedPath(4),
    ]);
    const win = { join: (...parts: string[]) => parts.join("\\") };
    expect(logFilePaths("C:\\plugin", win)[2]).toBe(
      "C:\\plugin\\diagnostic.2.log",
    );
  });
});

describe("createLogSink — location (R-01)", () => {
  test("lines land in <dir>/diagnostic.log and every path touched lies under dir", async () => {
    const { sink, memory } = setup({ maxFileBytes: 100 });
    expect(sink.path).toBe(currentPath);
    for (let i = 1; i <= 8; i += 1) sink.write(line30(i));
    await sink.flush();
    await sink.tail(10);
    await sink.clear();
    expect(memory.touched.size).toBeGreaterThan(0);
    for (const path of memory.touched) {
      expect(path.startsWith(`${DIR}/`)).toBe(true);
    }
  });

  test("a line is written verbatim to the current file", async () => {
    const { sink, memory } = setup();
    sink.write("first\n");
    sink.write("second\n");
    await sink.flush();
    expect(memory.files.get(currentPath)).toBe("first\nsecond\n");
  });
});

describe("createLogSink — rotation (R-04)", () => {
  test("rotation happens when the next line would pass the threshold, not when it reaches it", async () => {
    const { sink, memory } = setup({ maxFileBytes: 90 });
    for (let i = 1; i <= 3; i += 1) sink.write(line30(i));
    await sink.flush();
    // 3 x 30 = 90 bytes: exactly the threshold, nothing passes it.
    expect(memory.files.size).toBe(1);
    expect(memory.files.get(currentPath)).toBe(
      line30(1) + line30(2) + line30(3),
    );

    sink.write(line30(4));
    await sink.flush();
    expect(memory.files.get(rotatedPath(1))).toBe(
      line30(1) + line30(2) + line30(3),
    );
    expect(memory.files.get(currentPath)).toBe(line30(4));
  });

  test("the real MAX_FILE_BYTES threshold is 5 MiB", async () => {
    const { sink, memory } = setup();
    const big = `${"x".repeat(65_535)}\n`; // 64 KiB exactly
    for (let i = 0; i < 80; i += 1) sink.write(big); // 80 x 64 KiB = 5 MiB
    await sink.flush();
    expect(memory.files.size).toBe(1);

    sink.write("overflow\n");
    await sink.flush();
    expect(memory.files.size).toBe(2);
    expect(memory.files.get(rotatedPath(1))?.length).toBe(80 * 65_536);
    expect(memory.files.get(currentPath)).toBe("overflow\n");
  });

  test("at most 5 files exist and the oldest is dropped", async () => {
    const { sink, memory } = setup({ maxFileBytes: 50 });
    // Each line is 30 bytes, so every line after the first rotates.
    for (let i = 1; i <= 8; i += 1) sink.write(line30(i));
    await sink.flush();
    expect(memory.files.size).toBe(5);
    expect(memory.files.get(currentPath)).toBe(line30(8));
    expect(memory.files.get(rotatedPath(1))).toBe(line30(7));
    expect(memory.files.get(rotatedPath(2))).toBe(line30(6));
    expect(memory.files.get(rotatedPath(3))).toBe(line30(5));
    expect(memory.files.get(rotatedPath(4))).toBe(line30(4));
    expect(memory.files.has(rotatedPath(5))).toBe(false);
  });

  test("an existing file's size counts: a restart does not reset the threshold", async () => {
    const { sink, memory } = setup({ maxFileBytes: 100 });
    const existing = `${"o".repeat(79)}\n`; // 80 bytes already on disk
    memory.files.set(currentPath, existing);
    sink.write(line30(1)); // 80 + 30 > 100
    await sink.flush();
    expect(memory.files.get(rotatedPath(1))).toBe(existing);
    expect(memory.files.get(currentPath)).toBe(line30(1));
  });

  test("a burst of 10,000 writes with no await loses no line, splits none, keeps order and never overlaps a rotation", async () => {
    // 6 bytes per line, 60,000 bytes in all, 15,000 per file: four files.
    const { sink, memory } = setup({ maxFileBytes: 15_000 });
    const expected: string[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const line = `${String(i).padStart(5, "0")}\n`;
      expected.push(line.trimEnd());
      sink.write(line);
    }
    await sink.flush();

    const lines = readAll(memory).split("\n");
    expect(lines.pop()).toBe(""); // trailing newline
    expect(lines).toHaveLength(10_000);
    for (const l of lines) expect(l).toMatch(/^\d{5}$/);
    expect(lines).toEqual(expected);
    expect(memory.files.size).toBeGreaterThan(1);
    expect(memory.files.size).toBeLessThanOrEqual(5);
    expect(memory.concurrentRenames).toBe(0);
  });
});

describe("createLogSink — failure episodes (R-11)", () => {
  test("100 failing events produce exactly one warning and no attempt while the pause lasts", async () => {
    const failing = { on: true };
    const { sink, warns, appendCalls } = setup({
      failWrites: () => failing.on,
    });
    for (let i = 0; i < 100; i += 1) {
      sink.write(line30(i % 100));
      await sink.flush();
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]?.startsWith(WARN_PREFIX)).toBe(true);
    // Only the first event was attempted; the clock never moved.
    expect(appendCalls.count).toBe(1);
  });

  test("flush never rejects, with a healthy or a failing file system", async () => {
    const failing = { on: false };
    const { sink } = setup({ failWrites: () => failing.on });
    sink.write("ok\n");
    await expect(sink.flush()).resolves.toBeUndefined();
    failing.on = true;
    sink.write("fails\n");
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  test("one millisecond short of the pause still makes no attempt; after it, a healthy file system resumes and onResume gets the dropped count", async () => {
    const failing = { on: true };
    const resumed: number[] = [];
    const { sink, memory, clock, warns, appendCalls } = setup({
      failWrites: () => failing.on,
      onResume: (n) => resumed.push(n),
    });
    for (let i = 0; i < 100; i += 1) {
      sink.write(line30(i % 100));
      await sink.flush();
    }
    const attemptsBefore = appendCalls.count;
    failing.on = false;

    clock.now += FAILURE_PAUSE_MS - 1;
    sink.write("still paused\n");
    await sink.flush();
    expect(appendCalls.count).toBe(attemptsBefore);
    expect(memory.files.has(currentPath)).toBe(false);

    clock.now += 2;
    sink.write("after\n");
    await sink.flush();
    expect(appendCalls.count).toBe(attemptsBefore + 1);
    expect(memory.files.get(currentPath)).toBe("after\n");
    expect(resumed).toEqual([101]);
    expect(warns).toHaveLength(1);
  });

  test("a later failure opens a new episode and a second warning", async () => {
    const failing = { on: true };
    const { sink, clock, warns } = setup({ failWrites: () => failing.on });
    sink.write("a\n");
    await sink.flush();
    expect(warns).toHaveLength(1);

    clock.now += FAILURE_PAUSE_MS + 1;
    failing.on = false;
    sink.write("b\n");
    await sink.flush();

    failing.on = true;
    sink.write("c\n");
    await sink.flush();
    expect(warns).toHaveLength(2);
    expect(warns[1]?.startsWith(WARN_PREFIX)).toBe(true);
  });
});

describe("createLogSink — tail", () => {
  /** 7 lines, 3 per file: current holds line 7, .1 holds 4-6, .2 holds 1-3. */
  async function sevenLines() {
    const ctx = setup({ maxFileBytes: 100 });
    for (let i = 1; i <= 7; i += 1) ctx.sink.write(line30(i));
    await ctx.sink.flush();
    return ctx;
  }
  const lines = (text: string) => text.split("\n").filter((l) => l !== "");

  test("tail(200) reaches into the rotated files when the current one is short", async () => {
    const { sink, memory } = await sevenLines();
    expect(memory.files.get(currentPath)).toBe(line30(7));
    const out = lines(await sink.tail(200));
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => line30(i).trim()));
  });

  test("tail(n) returns exactly the last n lines across files", async () => {
    const { sink } = await sevenLines();
    expect(lines(await sink.tail(2))).toEqual(
      [6, 7].map((i) => line30(i).trim()),
    );
    expect(lines(await sink.tail(5))).toEqual(
      [3, 4, 5, 6, 7].map((i) => line30(i).trim()),
    );
  });

  test("tail includes writes that are still pending", async () => {
    const { sink } = setup();
    sink.write("one\n");
    sink.write("two\n");
    sink.write("three\n");
    expect(lines(await sink.tail(10))).toEqual(["one", "two", "three"]);
  });
});

describe("createLogSink — clear", () => {
  test("clear removes all five files", async () => {
    const { sink, memory } = setup({ maxFileBytes: 50 });
    for (let i = 1; i <= 8; i += 1) sink.write(line30(i));
    await sink.flush();
    expect(memory.files.size).toBe(5);
    await sink.clear();
    expect(memory.files.size).toBe(0);
  });

  test("clear tolerates files that do not exist", async () => {
    const { sink, memory } = setup();
    await expect(sink.clear()).resolves.toBeUndefined();
    sink.write("only current\n");
    await sink.flush();
    await expect(sink.clear()).resolves.toBeUndefined();
    expect(memory.files.size).toBe(0);
  });

  test("clear queued behind a burst never overlaps a rotation", async () => {
    const { sink, memory } = setup({ maxFileBytes: 100 });
    for (let i = 0; i < 50; i += 1) sink.write(line30(i));
    const cleared = sink.clear();
    await cleared;
    expect(memory.files.size).toBe(0);
    expect(memory.concurrentRenames).toBe(0);
  });

  test("the next write after a clear creates a fresh file", async () => {
    const { sink, memory } = setup({ maxFileBytes: 100 });
    for (let i = 1; i <= 7; i += 1) sink.write(line30(i));
    await sink.clear();
    sink.write("fresh\n");
    await sink.flush();
    expect(memory.files.size).toBe(1);
    expect(memory.files.get(currentPath)).toBe("fresh\n");
  });
});
