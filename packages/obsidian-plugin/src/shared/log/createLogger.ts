/**
 * The logger: level filter, redaction and sink wiring (ADR-0029 D1-D3, D6,
 * D7).
 *
 * Until `configure()` the logger touches no file system: it holds at most
 * `PENDING_ENTRY_LIMIT` raw entries, the oldest dropped first, and formats
 * them at configuration time so path redaction reaches them too. `close()`
 * drains the sink, detaches it and discards anything held, which returns
 * the logger to its unconfigured state.
 *
 * `debug`, `info`, `warn` and `error` are synchronous and never throw.
 *
 * Frozen messages:
 *   "diagnostic log resumed"        WARN  { droppedLines }
 *   "diagnostic log cleared"        INFO  written at any level
 *   "diagnostic log level changed"  INFO  { from, to }, written at any level
 * Console warning prefix: "MCP Connector: the diagnostic log cannot be written"
 */

import {
  DEFAULT_LOG_LEVEL,
  formatLogLine,
  isLevelEnabled,
  type LogEntry,
  type LogFields,
  type LogLevel,
} from "./logLine";
import {
  createLogSink,
  PENDING_ENTRY_LIMIT,
  type LogFs,
  type LogSink,
} from "./logSink";
import { createRedactor, type RedactionPaths } from "./redact";

export type LoggerConfig = {
  dir: string;
  level: LogLevel;
  fs: LogFs;
  paths?: RedactionPaths;
  now?: () => number;
  warn?: (message: string) => void;
};

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  configure(config: LoggerConfig): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  getLogPath(): string | null;
  tail(lines: number): Promise<string>;
  clear(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  rememberSecrets(secrets: readonly string[]): void;
}

/**
 * `defaults.warn` is the failure warning used when `configure()` passes
 * none. The facade supplies `console.warn`; this module never reaches the
 * console itself.
 */
export function createLogger(defaults?: {
  warn?: (message: string) => void;
}): Logger {
  const redactor = createRedactor();
  let level: LogLevel = DEFAULT_LOG_LEVEL;
  let sink: LogSink | null = null;
  let now: () => number = () => Date.now();
  let held: LogEntry[] = [];

  function writeEntry(target: LogSink, entry: LogEntry): void {
    target.write(formatLogLine(entry, (text) => redactor.scrub(text)));
  }

  function emit(
    entryLevel: LogLevel,
    message: string,
    fields: LogFields | undefined,
    force = false,
  ): void {
    try {
      if (sink === null) {
        held.push({
          timestamp: Date.now(),
          level: entryLevel,
          message,
          fields,
        });
        if (held.length > PENDING_ENTRY_LIMIT) held.shift();
        return;
      }
      if (!force && !isLevelEnabled(entryLevel, level)) return;
      writeEntry(sink, {
        timestamp: now(),
        level: entryLevel,
        message,
        fields,
      });
    } catch {
      // Logging never breaks the caller (ADR-0029 invariant 1).
    }
  }

  const logger: Logger = {
    debug: (message, fields) => emit("DEBUG", message, fields),
    info: (message, fields) => emit("INFO", message, fields),
    warn: (message, fields) => emit("WARN", message, fields),
    error: (message, fields) => emit("ERROR", message, fields),

    configure(config) {
      now = config.now ?? (() => Date.now());
      level = config.level;
      redactor.setPaths(config.paths ?? {});
      const warn = config.warn ?? defaults?.warn ?? (() => {});
      const next = createLogSink({
        dir: config.dir,
        fs: config.fs,
        now,
        warn,
        onResume: (droppedLines) =>
          emit("WARN", "diagnostic log resumed", { droppedLines }, true),
      });
      sink = next;
      const pending = held;
      held = [];
      for (const entry of pending) {
        if (!isLevelEnabled(entry.level, level)) continue;
        try {
          writeEntry(next, entry);
        } catch {
          // A hostile held entry is dropped, not the rest.
        }
      }
    },

    setLevel(next) {
      const from = level;
      level = next;
      if (from !== next) {
        emit("INFO", "diagnostic log level changed", { from, to: next }, true);
      }
    },

    getLevel: () => level,

    getLogPath: () => sink?.path ?? null,

    async tail(lines) {
      return sink === null ? "" : sink.tail(lines);
    },

    async clear() {
      if (sink === null) return;
      await sink.clear();
      emit("INFO", "diagnostic log cleared", undefined, true);
    },

    async flush() {
      if (sink !== null) await sink.flush();
    },

    async close() {
      const closing = sink;
      sink = null;
      held = [];
      if (closing !== null) await closing.flush();
      held = [];
    },

    rememberSecrets(secrets) {
      try {
        redactor.rememberSecrets(secrets);
      } catch {
        // Never throws into the token store.
      }
    },
  };

  return logger;
}
