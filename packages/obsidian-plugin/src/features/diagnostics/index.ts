/**
 * Diagnostics: the user-facing log (ADR-0029).
 *
 * The facade (`$/shared/logger`) imports nothing that imports the logger,
 * so configuration flows from here into it: where the file lives, which
 * paths and secrets to redact, and the persisted level.
 */

import type McpToolsPlugin from "$/main";
import { readTokens } from "$/features/mcp-transport/services/tokenStore";
import { logger } from "$/shared/logger";
import { DEFAULT_LOG_LEVEL } from "$/shared/log/logLine";
import { nodeLogFs } from "$/shared/log/nodeLogFs";
import { readLogLevel } from "./services/logLevelSetting";
import { resolveLogLocation } from "./services/logLocation";

export { default as FeatureSettings } from "./components/DiagnosticsSection.svelte";

/**
 * Points the logger at `<plugin dir>/diagnostic.log`. Never throws: a
 * vault without a file-system adapter, or any failure here, leaves the
 * logger unconfigured, which writes nothing and holds a bounded number of
 * entries in memory.
 */
export async function setup(plugin: McpToolsPlugin): Promise<void> {
  try {
    const location = await resolveLogLocation(plugin);
    if (location === null) return;
    try {
      // Seeds the redactor: readTokens registers every secret it reads.
      await readTokens(plugin);
    } catch {
      // No token list yet: setup registers them as it creates them.
    }
    // An unreadable data.json still gets a log, at the default level.
    const level = await readLogLevel(plugin).catch(() => DEFAULT_LOG_LEVEL);
    logger.configure({
      dir: location.dir,
      level,
      fs: nodeLogFs,
      paths: location.paths,
    });
  } catch {
    // The plugin loads whether or not its log can be written (R-11).
  }
}
