import { describe, expect, test } from "bun:test";
import { createLogger, type Logger, type LoggerConfig } from "./createLogger";
import { FAILURE_PAUSE_MS, PENDING_ENTRY_LIMIT } from "./logSink";
import { createMemoryLogFs } from "./memoryLogFs";
import { REDACTED_SECRET } from "./redact";

const DIR = "/mem";
const LOG_PATH = "/mem/diagnostic.log";
const WARN_PREFIX = "MCP Connector: the diagnostic log cannot be written";

type Parsed = {
  timestamp: string;
  level: string;
  message: string;
  fields: Record<string, unknown>;
};

function setup(overrides?: Partial<LoggerConfig>) {
  const logger = createLogger();
  const fs = createMemoryLogFs();
  const warns: string[] = [];
  logger.configure({
    dir: DIR,
    level: "INFO",
    fs,
    warn: (m) => warns.push(m),
    ...overrides,
  });
  return { logger, fs, warns };
}

async function written(
  logger: Logger,
  fs: { files: Map<string, string> },
): Promise<Parsed[]> {
  await logger.flush();
  const text = fs.files.get(LOG_PATH) ?? "";
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Parsed);
}

/** The frozen lifecycle messages are not what these tests count. */
const notLifecycle = (p: Parsed) => !p.message.startsWith("diagnostic log ");

describe("createLogger — before configure()", () => {
  test("getLogPath() is null", () => {
    expect(createLogger().getLogPath()).toBeNull();
  });

  test("an unconfigured logger holds at most PENDING_ENTRY_LIMIT entries", async () => {
    const logger = createLogger();
    for (let i = 0; i < PENDING_ENTRY_LIMIT + 500; i += 1) {
      logger.info(`event ${i}`);
    }
    const fs = createMemoryLogFs();
    logger.configure({ dir: DIR, level: "INFO", fs });
    const lines = await written(logger, fs);
    const events = lines.filter(notLifecycle);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(PENDING_ENTRY_LIMIT);
  });

  test("held entries are written at configure(), with path redaction applied", async () => {
    const logger = createLogger();
    logger.info("opened /Users/me/Vault/n.md", {
      path: "/Users/me/Vault/x.md",
    });
    const fs = createMemoryLogFs();
    logger.configure({
      dir: DIR,
      level: "INFO",
      fs,
      paths: { vault: ["/Users/me/Vault"] },
    });
    const lines = (await written(logger, fs)).filter(notLifecycle);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("opened <vault>/n.md");
    expect(lines[0]?.fields.path).toBe("<vault>/x.md");
  });

  test("a secret remembered before configure() redacts the held entries", async () => {
    const secret = "ab+/=!cd".repeat(5);
    const logger = createLogger();
    logger.rememberSecrets([secret]);
    logger.error(`leaked ${secret}`, { secret });
    const fs = createMemoryLogFs();
    logger.configure({ dir: DIR, level: "INFO", fs });
    await logger.flush();
    const text = fs.files.get(LOG_PATH) ?? "";
    expect(text).not.toContain(secret);
    expect(text).toContain(REDACTED_SECRET);
  });
});

describe("createLogger — configured", () => {
  test("getLogPath() is the file in the configured directory", () => {
    const { logger } = setup();
    expect(logger.getLogPath()).toBe(LOG_PATH);
  });

  test("a line is one JSON object with the message and fields (R-02)", async () => {
    const { logger, fs } = setup();
    logger.info("hello", { port: 27124 });
    const lines = (await written(logger, fs)).filter(notLifecycle);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("INFO");
    expect(lines[0]?.message).toBe("hello");
    expect(lines[0]?.fields).toEqual({ port: 27124 });
    expect(Number.isNaN(Date.parse(lines[0]!.timestamp))).toBe(false);
  });

  test("an Error in fields carries message and stack on that line (R-02)", async () => {
    const { logger, fs } = setup();
    logger.error("failed", { error: new Error("boom") });
    const lines = (await written(logger, fs)).filter(notLifecycle);
    const err = lines[0]?.fields.error as Record<string, unknown>;
    expect(err.message).toBe("boom");
    expect(typeof err.stack).toBe("string");
  });

  test("paths in a live line are redacted", async () => {
    const { logger, fs } = setup({
      paths: { vault: ["/Users/me/Vault"], home: ["/Users/me"] },
    });
    logger.warn("missing /Users/me/Vault/a.md", {
      cache: "/Users/me/Library/x",
    });
    const lines = (await written(logger, fs)).filter(notLifecycle);
    expect(lines[0]?.message).toBe("missing <vault>/a.md");
    expect(lines[0]?.fields.cache).toBe("<home>/Library/x");
  });

  test("rememberSecrets applies to later lines", async () => {
    const secret = "ab+/=!cd".repeat(5);
    const { logger, fs } = setup();
    logger.rememberSecrets([secret]);
    logger.info(`header ${secret}`, { nested: { value: secret } });
    await logger.flush();
    const text = fs.files.get(LOG_PATH) ?? "";
    expect(text).not.toContain(secret);
    expect(text).toContain(REDACTED_SECRET);
  });
});

describe("createLogger — level (R-03)", () => {
  test("DEBUG is dropped at the default level and setLevel takes effect on the next call", async () => {
    const { logger, fs } = setup({ level: "INFO" });
    expect(logger.getLevel()).toBe("INFO");
    logger.debug("d1");
    logger.info("i1");
    logger.setLevel("DEBUG");
    expect(logger.getLevel()).toBe("DEBUG");
    logger.debug("d2");
    const messages = (await written(logger, fs))
      .filter(notLifecycle)
      .map((l) => l.message);
    expect(messages).toEqual(["i1", "d2"]);
  });

  test("raising the level stops lower events", async () => {
    const { logger, fs } = setup({ level: "DEBUG" });
    logger.setLevel("ERROR");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    const messages = (await written(logger, fs))
      .filter(notLifecycle)
      .map((l) => l.message);
    expect(messages).toEqual(["e"]);
  });

  test("the level-changed line is written even at ERROR", async () => {
    const { logger, fs } = setup({ level: "ERROR" });
    logger.info("hidden");
    logger.setLevel("WARN");
    const lines = await written(logger, fs);
    expect(lines.map((l) => l.message)).not.toContain("hidden");
    const changed = lines.find(
      (l) => l.message === "diagnostic log level changed",
    );
    expect(changed).toBeDefined();
    expect(changed?.level).toBe("INFO");
    expect(changed?.fields).toEqual({ from: "ERROR", to: "WARN" });
  });

  test("the cleared line is written even at ERROR, as the first line of the fresh file", async () => {
    const { logger, fs } = setup({ level: "ERROR" });
    logger.error("old");
    await logger.flush();
    expect(fs.files.get(LOG_PATH)).toContain("old");

    await logger.clear();
    const lines = await written(logger, fs);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("diagnostic log cleared");
    expect(lines[0]?.level).toBe("INFO");
  });
});

describe("createLogger — hostile input", () => {
  test("the four methods never throw on hostile fields, and the line is still written", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const getter: Record<string, unknown> = {};
    Object.defineProperty(getter, "x", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    const hostile = [
      circular,
      { n: BigInt(10) },
      getter,
      {
        toJSON: () => {
          throw new Error("toJSON");
        },
      },
      undefined,
    ];
    const { logger, fs } = setup({ level: "DEBUG" });
    for (const fields of hostile) {
      expect(() => logger.debug("m-debug", fields as never)).not.toThrow();
      expect(() => logger.info("m-info", fields as never)).not.toThrow();
      expect(() => logger.warn("m-warn", fields as never)).not.toThrow();
      expect(() => logger.error("m-error", fields as never)).not.toThrow();
    }
    const messages = (await written(logger, fs)).map((l) => l.message);
    for (const m of ["m-debug", "m-info", "m-warn", "m-error"]) {
      expect(messages).toContain(m);
    }
  });

  test("a Proxy that throws on every access does not make a method throw", async () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("proxy get");
        },
        ownKeys() {
          throw new Error("proxy ownKeys");
        },
        getOwnPropertyDescriptor() {
          throw new Error("proxy descriptor");
        },
      },
    );
    const { logger } = setup({ level: "DEBUG" });
    expect(() => logger.info("proxy", proxy as never)).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
    const unconfigured = createLogger();
    expect(() => unconfigured.error("proxy", proxy as never)).not.toThrow();
  });
});

describe("createLogger — tail", () => {
  test("tail returns the last lines, already redacted", async () => {
    const { logger } = setup({ paths: { vault: ["/Users/me/Vault"] } });
    logger.info("m1");
    logger.info("m2 /Users/me/Vault/a.md");
    logger.info("m3");
    const tail = await logger.tail(2);
    const lines = tail
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Parsed);
    expect(lines.map((l) => l.message)).toEqual(["m2 <vault>/a.md", "m3"]);
  });
});

describe("createLogger — close()", () => {
  test("close drains pending writes, then later events touch nothing", async () => {
    const { logger, fs } = setup();
    logger.info("m1");
    logger.info("m2");
    logger.info("m3");
    await logger.close();
    const before = (fs.files.get(LOG_PATH) ?? "")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as Parsed).message);
    expect(before.filter((m) => !m.startsWith("diagnostic log "))).toEqual([
      "m1",
      "m2",
      "m3",
    ]);

    const touched = new Set(fs.touched);
    const content = fs.files.get(LOG_PATH);
    logger.info("late");
    logger.error("later");
    await logger.flush();
    expect(new Set(fs.touched)).toEqual(touched);
    expect(fs.files.get(LOG_PATH)).toBe(content);
  });

  test("close discards entries held before it, so a later configure() does not receive them", async () => {
    const logger = createLogger();
    logger.info("held before close");
    await logger.close();
    const fs = createMemoryLogFs();
    logger.configure({ dir: DIR, level: "INFO", fs });
    logger.info("after");
    const messages = (await written(logger, fs))
      .filter(notLifecycle)
      .map((l) => l.message);
    expect(messages).toEqual(["after"]);
  });
});

describe("createLogger — failure handling (R-11)", () => {
  test("a failure warning goes to config.warn, once per episode", async () => {
    const failing = { on: true };
    const fs = createMemoryLogFs({ failWrites: () => failing.on });
    const warns: string[] = [];
    const logger = createLogger();
    logger.configure({
      dir: DIR,
      level: "INFO",
      fs,
      warn: (m) => warns.push(m),
    });
    for (let i = 0; i < 20; i += 1) {
      logger.info(`event ${i}`);
      await logger.flush();
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]?.startsWith(WARN_PREFIX)).toBe(true);
  });

  test("when writing resumes, a WARN line records how many lines were dropped", async () => {
    const failing = { on: true };
    const clock = { now: 5_000_000 };
    const fs = createMemoryLogFs({ failWrites: () => failing.on });
    const logger = createLogger();
    logger.configure({
      dir: DIR,
      level: "INFO",
      fs,
      now: () => clock.now,
      warn: () => {},
    });
    logger.info("lost");
    await logger.flush();
    expect(fs.files.has(LOG_PATH)).toBe(false);

    failing.on = false;
    clock.now += FAILURE_PAUSE_MS + 1;
    logger.info("kept");
    const lines = await written(logger, fs);
    const resumed = lines.find((l) => l.message === "diagnostic log resumed");
    expect(resumed).toBeDefined();
    expect(resumed?.level).toBe("WARN");
    expect(resumed?.fields).toEqual({ droppedLines: 1 });
    expect(lines.map((l) => l.message)).toContain("kept");
    expect(lines.map((l) => l.message)).not.toContain("lost");
  });

  test("an unwritable log never makes a method throw", async () => {
    const fs = createMemoryLogFs({ failWrites: () => true });
    const logger = createLogger();
    logger.configure({ dir: DIR, level: "DEBUG", fs, warn: () => {} });
    expect(() => logger.error("x", { a: 1 })).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
