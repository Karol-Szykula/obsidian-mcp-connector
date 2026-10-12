/**
 * Log line contract: levels, bounds and the one-JSON-object-per-line format
 * (ADR-0029 D1, D3).
 *
 * Every string is scrubbed before it is capped, so a cap can never cut a
 * secret into a fragment the redaction patterns no longer recognise. The
 * value tree is rebuilt into plain JSON data before `JSON.stringify` runs,
 * so no caller-supplied `toJSON`, getter or cycle is ever reached by the
 * serialiser itself.
 */

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export type LogEntry = {
  timestamp: number;
  level: LogLevel;
  message: string;
  fields?: LogFields;
};

export const DEFAULT_LOG_LEVEL: LogLevel = "INFO";

/** A formatted line never exceeds this many bytes. */
export const MAX_LINE_BYTES = 65_536;

/** A single string is capped at this many characters, after scrubbing. */
export const MAX_STRING_CHARS = 8_192;

/** Placeholder for a value that cannot be serialised. */
export const UNSERIALIZABLE = "[unserializable]";

/** Before scrubbing, a string is cut to this many characters. */
const PRE_CAP_CHARS = 65_536;

/** Nesting deeper than this is replaced by the placeholder. */
const MAX_DEPTH = 16;

const TRAILING_BASE64URL_RUN = /[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();

/** A missing or invalid value resolves to the default level. */
export function parseLogLevel(value: unknown): LogLevel {
  return (LOG_LEVELS as readonly unknown[]).includes(value)
    ? (value as LogLevel)
    : DEFAULT_LOG_LEVEL;
}

/** True when an event at `level` passes a `minimum` threshold. */
export function isLevelEnabled(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}

/**
 * Scrub, then cap. A string longer than the pre-cap is cut first, and a
 * base64url run left dangling at the cut is dropped with it, so no token
 * fragment survives the cut either.
 */
function boundString(text: string, scrub: (text: string) => string): string {
  let raw = text;
  if (raw.length > PRE_CAP_CHARS) {
    raw = raw.slice(0, PRE_CAP_CHARS).replace(TRAILING_BASE64URL_RUN, "");
  }
  const scrubbed = scrub(raw);
  return scrubbed.length > MAX_STRING_CHARS
    ? `${scrubbed.slice(0, MAX_STRING_CHARS - 1)}…`
    : scrubbed;
}

function serializeError(
  error: Error,
  scrub: (text: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["name", "message", "stack", "code"] as const) {
    try {
      const value: unknown = (error as unknown as Record<string, unknown>)[key];
      if (value === undefined) continue;
      out[key] =
        typeof value === "string"
          ? boundString(value, scrub)
          : typeof value === "number"
            ? value
            : UNSERIALIZABLE;
    } catch {
      out[key] = UNSERIALIZABLE;
    }
  }
  return out;
}

/**
 * Rebuilds `value` as plain JSON data with every string scrubbed and
 * capped. Returns `undefined` for what JSON would omit (functions,
 * symbols, `undefined`). Never throws.
 */
function toPlain(
  value: unknown,
  scrub: (text: string) => string,
  ancestors: object[],
): unknown {
  try {
    switch (typeof value) {
      case "string":
        return boundString(value, scrub);
      case "number":
      case "boolean":
        return value;
      case "bigint":
        return UNSERIALIZABLE;
      case "undefined":
      case "function":
      case "symbol":
        return undefined;
    }
    if (value === null) return null;
    const obj = value as object;
    if (ancestors.includes(obj) || ancestors.length >= MAX_DEPTH) {
      return UNSERIALIZABLE;
    }
    if (obj instanceof Error) return serializeError(obj, scrub);
    if (obj instanceof Date) return obj.toISOString();

    const nested = [...ancestors, obj];
    if (Array.isArray(obj)) {
      return obj.map((item: unknown) => {
        const plain = toPlain(item, scrub, nested);
        return plain === undefined ? null : plain;
      });
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      let plain: unknown;
      try {
        plain = toPlain((obj as Record<string, unknown>)[key], scrub, nested);
      } catch {
        plain = UNSERIALIZABLE;
      }
      if (plain !== undefined) out[boundString(key, scrub)] = plain;
    }
    return out;
  } catch {
    return UNSERIALIZABLE;
  }
}

function plainFields(
  fields: LogFields | undefined,
  scrub: (text: string) => string,
): Record<string, unknown> {
  if (fields === undefined || fields === null) return {};
  const plain = toPlain(fields, scrub, []);
  if (plain !== null && typeof plain === "object" && !Array.isArray(plain)) {
    return plain as Record<string, unknown>;
  }
  return { fields: plain === undefined ? UNSERIALIZABLE : plain };
}

function isoTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** One JSON object followed by a newline. Scrubs before truncating. */
export function formatLogLine(
  entry: LogEntry,
  scrub: (text: string) => string,
): string {
  const head = {
    timestamp: isoTimestamp(entry.timestamp),
    level: entry.level,
    message: boundString(String(entry.message), scrub),
  };
  const line = `${JSON.stringify({
    ...head,
    fields: plainFields(entry.fields, scrub),
  })}\n`;
  const bytes = encoder.encode(line).length;
  if (bytes <= MAX_LINE_BYTES) return line;
  return `${JSON.stringify({
    ...head,
    fields: { truncated: true, originalBytes: bytes },
  })}\n`;
}
