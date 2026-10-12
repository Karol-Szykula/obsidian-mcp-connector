import { createLogger, type Logger } from "./log/createLogger";

export type { LogLevel, LogFields } from "./log/logLine";
export type { Logger, LoggerConfig } from "./log/createLogger";

/**
 * The plugin's one logger (ADR-0029). Unconfigured until the diagnostics
 * feature calls `configure()` at load; until then it holds a bounded
 * number of entries in memory and never touches the disk.
 *
 * The default failure warning is the single sanctioned `console` call in
 * plugin code: one line per failure episode, when the log file cannot be
 * written (ADR-0029 D6, D8).
 */
export const logger: Logger = createLogger({
  warn: (message) => console.warn(message),
});
