/**
 * Test helper: points the shared `logger` at an in-memory file system for
 * every test of the calling `describe`, and reads back the lines actually
 * written, after redaction. Never imported by production code.
 *
 * Call it inside a `describe` body: it registers that block's `beforeEach`
 * and `afterEach`, so the tests outside it run against whatever the logger
 * is at the time.
 *
 * Closing first keeps entries held by other test files out of the memory
 * file system; closing last detaches the logger again.
 */

import { afterEach, beforeEach } from "bun:test";
import { logger } from "$/shared/logger";
import { createMemoryLogFs } from "./memoryLogFs";

const LOG_DIR = "/mem";
const LOG_PATH = `${LOG_DIR}/diagnostic.log`;

export type CapturedLine = {
  level: string;
  message: string;
  fields: Record<string, unknown>;
};

export type LogCapture = {
  /** Polls until `until` holds or a deadline passes, then reads the lines. */
  lines(until: (all: CapturedLine[]) => boolean): Promise<CapturedLine[]>;
  has(all: CapturedLine[], message: string): boolean;
  named(all: CapturedLine[], message: string): CapturedLine[];
  /** The raw file content written so far, without flushing. */
  written(): string;
};

export function captureLogLines(options?: {
  /** Runs in `afterEach` before the logger is closed. */
  beforeClose?: () => Promise<void>;
}): LogCapture {
  let memory = createMemoryLogFs();

  beforeEach(async () => {
    await logger.close();
    memory = createMemoryLogFs();
    logger.configure({ dir: LOG_DIR, level: "DEBUG", fs: memory });
  });

  afterEach(async () => {
    await options?.beforeClose?.();
    await logger.close();
  });

  const written = () => memory.files.get(LOG_PATH) ?? "";

  const read = async (): Promise<CapturedLine[]> => {
    await logger.flush();
    return written()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as CapturedLine);
  };

  /** Lets the response-side `finally` run, then reads what was written. */
  async function lines(
    until: (all: CapturedLine[]) => boolean,
  ): Promise<CapturedLine[]> {
    // Poll for the event the test is about, not a fixed sleep: the
    // response-side `finally` runs after the client has the response, so how
    // long it takes is the runner's load, not a constant. A deadline that
    // passes returns what is there and lets the assertion name the miss.
    const deadline = Date.now() + 5000;
    let all = await read();
    while (!until(all) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      all = await read();
    }
    // Bounded settle, once the awaited line is in: assertions on a count or
    // on absence (`toEqual([])`) can only fail if a stray line arrives late,
    // so a short wait here makes them stricter, never flakier.
    await new Promise((r) => setTimeout(r, 20));
    return read();
  }

  return {
    lines,
    has: (all, message) => all.some((l) => l.message === message),
    named: (all, message) => all.filter((l) => l.message === message),
    written,
  };
}
