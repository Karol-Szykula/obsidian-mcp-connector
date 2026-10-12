import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  MAX_LINE_BYTES,
  MAX_STRING_CHARS,
  UNSERIALIZABLE,
  formatLogLine,
  isLevelEnabled,
  parseLogLevel,
  type LogLevel,
} from "./logLine";
import { REDACTED_TOKEN, TOKEN_SHAPED_PATTERN } from "./redact";

const identity = (text: string) => text;
const T0 = 1_760_000_000_000;

function parse(line: string): {
  timestamp: string;
  level: string;
  message: string;
  fields: Record<string, unknown>;
} {
  return JSON.parse(line) as ReturnType<typeof parse>;
}

describe("formatLogLine — line shape (R-02)", () => {
  test("one JSON object ending in a single newline, with the four keys in order", () => {
    const line = formatLogLine(
      { timestamp: T0, level: "INFO", message: "hello", fields: { a: 1 } },
      identity,
    );
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    const obj = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(obj)).toEqual([
      "timestamp",
      "level",
      "message",
      "fields",
    ]);
    expect(obj.timestamp).toBe(new Date(T0).toISOString());
    expect(obj.level).toBe("INFO");
    expect(obj.message).toBe("hello");
    expect(obj.fields).toEqual({ a: 1 });
  });

  test("an entry without fields still carries a fields object", () => {
    const line = formatLogLine(
      { timestamp: T0, level: "WARN", message: "bare" },
      identity,
    );
    expect(parse(line).fields).toEqual({});
  });

  test("a message holding newlines stays on one physical line", () => {
    const line = formatLogLine(
      { timestamp: T0, level: "INFO", message: "a\nb\r\nc", fields: {} },
      identity,
    );
    expect(line.split("\n")).toHaveLength(2);
    expect(parse(line).message).toBe("a\nb\r\nc");
  });
});

describe("formatLogLine — errors (R-02)", () => {
  test("an Error in fields becomes {name, message, stack} on the same line", () => {
    const err = new TypeError("boom");
    const line = formatLogLine(
      { timestamp: T0, level: "ERROR", message: "failed", fields: { err } },
      identity,
    );
    expect(line.split("\n")).toHaveLength(2);
    const out = parse(line).fields.err as Record<string, unknown>;
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("boom");
    expect(typeof out.stack).toBe("string");
    expect(out.stack as string).toContain("boom");
  });

  test("an Error nested in objects and arrays is serialised the same way", () => {
    const err = new Error("deep");
    const line = formatLogLine(
      {
        timestamp: T0,
        level: "ERROR",
        message: "failed",
        fields: { outer: { list: [1, { err }] } },
      },
      identity,
    );
    const outer = parse(line).fields.outer as { list: unknown[] };
    const nested = (outer.list[1] as { err: Record<string, unknown> }).err;
    expect(nested.name).toBe("Error");
    expect(nested.message).toBe("deep");
    expect(typeof nested.stack).toBe("string");
  });
});

describe("formatLogLine — unserialisable values", () => {
  test("a circular value becomes the placeholder and the line is still written", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const line = formatLogLine(
      {
        timestamp: T0,
        level: "INFO",
        message: "cyclic",
        fields: { circular, ok: 1 },
      },
      identity,
    );
    const obj = parse(line);
    expect(obj.message).toBe("cyclic");
    expect(obj.fields.ok).toBe(1);
    expect(line).toContain(UNSERIALIZABLE);
  });

  test("a bigint becomes the placeholder and its siblings survive", () => {
    const line = formatLogLine(
      {
        timestamp: T0,
        level: "INFO",
        message: "big",
        fields: { n: BigInt(10), ok: "yes" },
      },
      identity,
    );
    const obj = parse(line);
    expect(obj.fields.n).toBe(UNSERIALIZABLE);
    expect(obj.fields.ok).toBe("yes");
  });

  test("a throwing getter becomes the placeholder and the line is still written", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    const line = formatLogLine(
      {
        timestamp: T0,
        level: "INFO",
        message: "getter",
        fields: { hostile, ok: true },
      },
      identity,
    );
    const obj = parse(line);
    expect(obj.message).toBe("getter");
    expect(obj.fields.ok).toBe(true);
    expect(line).toContain(UNSERIALIZABLE);
  });
});

describe("formatLogLine — scrub coverage (R-05, R-06)", () => {
  const scrub = (text: string) => text.split("SECRET").join("X");

  test("the scrub reaches the message, nested values, keys, array elements and stacks", () => {
    const err = new Error("SECRET in message");
    err.stack = "Error: SECRET in message\n    at SECRET (file.ts:1:1)";
    const line = formatLogLine(
      {
        timestamp: T0,
        level: "ERROR",
        message: "msg SECRET end",
        fields: {
          "key-SECRET": "value SECRET",
          nested: { deeper: { leaf: "leaf-SECRET" } },
          list: ["SECRET-0", { inner: "SECRET-1" }],
          err,
        },
      },
      scrub,
    );
    expect(line).not.toContain("SECRET");
    const obj = parse(line);
    expect(obj.message).toBe("msg X end");
    expect(obj.fields["key-X"]).toBe("value X");
    const err2 = obj.fields.err as { message: string; stack: string };
    expect(err2.message).toBe("X in message");
    expect(err2.stack).toContain("at X (file.ts:1:1)");
  });
});

describe("formatLogLine — truncation (R-05)", () => {
  const tokenScrub = (text: string) =>
    text.replace(TOKEN_SHAPED_PATTERN, REDACTED_TOKEN);

  test("a string is capped at MAX_STRING_CHARS", () => {
    const long = "word ".repeat(10_000);
    const line = formatLogLine(
      { timestamp: T0, level: "INFO", message: "m", fields: { long } },
      identity,
    );
    const out = parse(line).fields.long as string;
    expect(out.length).toBeLessThanOrEqual(MAX_STRING_CHARS);
    expect(out.startsWith("word word word")).toBe(true);
  });

  test("a token straddling the MAX_STRING_CHARS boundary leaves no fragment, because the scrub runs first", () => {
    const token = "Zk3_-aB9".repeat(6).slice(0, 43);
    expect(token).toHaveLength(43);
    // Spaces are not base64url, so the token is a run on its own. It starts
    // 20 characters before the cap and ends 23 characters after it.
    const value = `${" ".repeat(MAX_STRING_CHARS - 20)}${token} ${"tail ".repeat(40)}`;
    expect(value.indexOf(token)).toBeLessThan(MAX_STRING_CHARS);
    expect(value.indexOf(token) + token.length).toBeGreaterThan(
      MAX_STRING_CHARS,
    );

    const line = formatLogLine(
      { timestamp: T0, level: "INFO", message: "m", fields: { value } },
      tokenScrub,
    );
    expect(line).not.toContain(token.slice(0, 10));
    expect(line).not.toContain(token.slice(-10));
    expect(line).toContain(REDACTED_TOKEN);
  });

  test("an oversized entry stays within MAX_LINE_BYTES, replaces fields with {truncated, originalBytes} and still parses", () => {
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) fields[`f${i}`] = "word ".repeat(1_600);
    const line = formatLogLine(
      { timestamp: T0, level: "WARN", message: "huge", fields },
      identity,
    );
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(line.endsWith("\n")).toBe(true);
    const obj = parse(line);
    expect(obj.level).toBe("WARN");
    expect(obj.message).toBe("huge");
    expect(obj.fields.truncated).toBe(true);
    expect(typeof obj.fields.originalBytes).toBe("number");
    expect(obj.fields.originalBytes as number).toBeGreaterThan(MAX_LINE_BYTES);
  });
});

describe("parseLogLevel and isLevelEnabled (R-03)", () => {
  test("the bounds are the documented ones", () => {
    expect([...LOG_LEVELS]).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
    expect(DEFAULT_LOG_LEVEL).toBe("INFO");
    expect(MAX_LINE_BYTES).toBe(65_536);
    expect(MAX_STRING_CHARS).toBe(8_192);
    expect(UNSERIALIZABLE).toBe("[unserializable]");
  });

  test("a missing or invalid value resolves to INFO", () => {
    expect(parseLogLevel(undefined)).toBe("INFO");
    expect(parseLogLevel(null)).toBe("INFO");
    expect(parseLogLevel("verbose")).toBe("INFO");
    expect(parseLogLevel(3)).toBe("INFO");
    expect(parseLogLevel("")).toBe("INFO");
    expect(parseLogLevel({})).toBe("INFO");
  });

  test("every valid level parses to itself", () => {
    for (const level of LOG_LEVELS) expect(parseLogLevel(level)).toBe(level);
  });

  test("isLevelEnabled passes the full level matrix", () => {
    // rows: event level; columns: configured minimum, in LOG_LEVELS order.
    const expected: Record<LogLevel, [boolean, boolean, boolean, boolean]> = {
      DEBUG: [true, false, false, false],
      INFO: [true, true, false, false],
      WARN: [true, true, true, false],
      ERROR: [true, true, true, true],
    };
    for (const level of LOG_LEVELS) {
      LOG_LEVELS.forEach((minimum, column) => {
        expect(isLevelEnabled(level, minimum)).toBe(expected[level][column]!);
      });
    }
  });
});
