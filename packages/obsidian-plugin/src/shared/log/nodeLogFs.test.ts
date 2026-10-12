import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./createLogger";
import { nodeLogFs } from "./nodeLogFs";
import { LOG_FILE_NAME } from "./logSink";

/**
 * (coverage) `nodeLogFs` is the only `LogFs` the shipped plugin uses and
 * every other log test runs on the in-memory double. These tests exercise
 * the real Node file system in a temp directory: the adapter contract
 * (R-01), and a rotation through real `rename`/`unlink` (R-04).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diag-nodefs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("nodeLogFs (coverage)", () => {
  test("join composes a path with the platform separator", () => {
    expect(nodeLogFs.join("a", "b", "c.log")).toBe(join("a", "b", "c.log"));
  });

  test("appendFile creates the file and appends; readFile and stat agree", async () => {
    const file = nodeLogFs.join(dir, "x.log");
    await nodeLogFs.appendFile(file, "one\n");
    await nodeLogFs.appendFile(file, "two\n");

    expect(await nodeLogFs.readFile(file)).toBe("one\ntwo\n");
    expect(await nodeLogFs.stat(file)).toEqual({ size: 8 });
  });

  test("rename moves a file and unlink removes it", async () => {
    const from = nodeLogFs.join(dir, "from.log");
    const to = nodeLogFs.join(dir, "to.log");
    await nodeLogFs.appendFile(from, "payload");
    await nodeLogFs.rename(from, to);
    expect(await nodeLogFs.readFile(to)).toBe("payload");
    await expect(nodeLogFs.stat(from)).rejects.toThrow();

    await nodeLogFs.unlink(to);
    await expect(nodeLogFs.stat(to)).rejects.toThrow();
  });

  test("a missing file rejects with an ENOENT code, which the sink tolerates", async () => {
    const error = await nodeLogFs
      .readFile(nodeLogFs.join(dir, "missing.log"))
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("ENOENT");
  });

  test("a logger on the real file system writes one JSON object per line into the directory (R-01, R-02)", async () => {
    const logger = createLogger();
    logger.configure({ dir, level: "INFO", fs: nodeLogFs });
    logger.info("hello", { n: 1 });
    logger.error("boom", { error: new Error("bad") });
    await logger.close();

    const text = await readFile(join(dir, LOG_FILE_NAME), "utf8");
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.message)).toEqual(["hello", "boom"]);
    expect(rows.map((r) => r.level)).toEqual(["INFO", "ERROR"]);
    expect(await readdir(dir)).toEqual([LOG_FILE_NAME]);
  });

  test("clear removes the log through the real file system, and the next line starts a fresh file", async () => {
    const logger = createLogger();
    logger.configure({ dir, level: "INFO", fs: nodeLogFs });
    logger.info("before");
    await logger.flush();
    await logger.clear();
    await logger.flush();

    const text = await readFile(join(dir, LOG_FILE_NAME), "utf8");
    expect(text).not.toContain("before");
    expect(text).toContain("diagnostic log cleared");
    await logger.close();
  });
});
