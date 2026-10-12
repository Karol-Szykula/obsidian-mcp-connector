/**
 * The persisted minimum log level, in its own settings slice (ADR-0029 D7).
 *
 * Reads go through `readSlice`, never `loadSlice`, which would persist the
 * default on first read. Writes go through `updateSlice`, so the level
 * shares the settings mutex with every other slice and an unchanged value
 * costs no save.
 */

import { parseLogLevel, type LogLevel } from "$/shared/log/logLine";
import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";

/** Slice shape: `{ logLevel: LogLevel }`. */
export const DIAGNOSTICS_SLICE = "diagnostics";

type DiagnosticsSlice = Record<string, unknown> & { logLevel: LogLevel };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function storedLevel(slice: unknown): unknown {
  return isRecord(slice) ? slice.logLevel : undefined;
}

/** Reads without ever writing. A missing or invalid value is INFO. */
export async function readLogLevel(
  plugin: PluginDataLike | undefined,
): Promise<LogLevel> {
  if (plugin === undefined) return parseLogLevel(undefined);
  const slice = await new SettingsStore(plugin).readSlice(DIAGNOSTICS_SLICE);
  return parseLogLevel(storedLevel(slice));
}

/** Persists through `updateSlice`; an unchanged value makes no save. */
export async function writeLogLevel(
  plugin: PluginDataLike,
  level: LogLevel,
): Promise<LogLevel> {
  await new SettingsStore(plugin).updateSlice(
    DIAGNOSTICS_SLICE,
    (current): unknown => {
      // The same reference means NO_CHANGE: no save.
      if (storedLevel(current) === level) return current;
      // Keep any other key in the slice: a later field must survive a
      // level change.
      const next: DiagnosticsSlice = {
        ...(isRecord(current) ? current : {}),
        logLevel: level,
      };
      return next;
    },
  );
  return level;
}
