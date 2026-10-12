<script lang="ts" module>
  /** How many lines "Copy last 200 lines" copies. */
  export const TAIL_LINES = 200;
</script>

<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { logger } from "$/shared/logger";
  import { LOG_LEVELS, type LogLevel } from "$/shared/log/logLine";
  import { writeLogLevel } from "../services/logLevelSetting";
  import { revealInFolder } from "../services/revealInFolder";

  /**
   * Diagnostics settings (ADR-0029, SPEC R-12). The level is persisted
   * first, then applied: a level the store refused never takes effect, and
   * the dropdown reverts. Every line in the file is already redacted, so
   * the copied tail needs no further scrub.
   */

  export let plugin: McpToolsPlugin;

  let level: LogLevel = logger.getLevel();
  let busy = false;
  const logPath = logger.getLogPath();

  async function onLevelChange(event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const previous = level;
    const next = select.value as LogLevel;
    busy = true;
    try {
      await writeLogLevel(plugin, next);
      logger.setLevel(next);
      level = next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save the log level: ${message}`);
      level = previous;
      select.value = previous;
    } finally {
      busy = false;
    }
  }

  function onShowInFolder(): void {
    if (logPath === null) return;
    if (!revealInFolder(logPath)) {
      new Notice(`The diagnostic log is at ${logPath}`);
    }
  }

  async function onCopyTail(): Promise<void> {
    busy = true;
    try {
      await navigator.clipboard.writeText(await logger.tail(TAIL_LINES));
      new Notice("Copied the last 200 log lines to the clipboard.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to copy the log: ${message}`);
    } finally {
      busy = false;
    }
  }

  async function onClear(): Promise<void> {
    if (
      !confirm(
        "Delete the diagnostic log and its rotated files? This cannot be undone.",
      )
    ) {
      return;
    }
    busy = true;
    try {
      await logger.clear();
      new Notice("Diagnostic log cleared.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to clear the log: ${message}`);
    } finally {
      busy = false;
    }
  }
</script>

<div class="diagnostics-settings">
  <h3>Diagnostics</h3>
  <p class="description">
    A log of what the plugin does: MCP requests, protocol negotiation,
    server start and stop, and tool errors. Tokens, tool argument values,
    note content and absolute paths are removed where known, but some
    failure lines name a vault-relative note path: review before posting.
    Attach it to an issue when reporting a problem.
  </p>

  <label class="row">
    <span class="label">Log level</span>
    <select value={level} on:change={onLevelChange} disabled={busy}>
      {#each LOG_LEVELS as option (option)}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </label>
  <p class="hint">
    INFO is the default. Switch to DEBUG while reproducing a problem, then
    back to INFO. Changes apply immediately.
  </p>

  <label class="row">
    <span class="label">Log file</span>
    <input
      type="text"
      readonly
      value={logPath ?? "not available"}
      class="path"
    />
  </label>

  <div class="actions">
    <button
      type="button"
      on:click={onShowInFolder}
      disabled={busy || logPath === null}
    >
      Show in folder
    </button>
    <button
      type="button"
      on:click={onCopyTail}
      disabled={busy || logPath === null}
    >
      Copy last 200 lines
    </button>
    <button
      type="button"
      class="mod-warning"
      on:click={onClear}
      disabled={busy || logPath === null}
    >
      Clear log
    </button>
  </div>
</div>

<style>
  .diagnostics-settings {
    margin-top: 2em;
  }

  .description,
  .hint {
    color: var(--text-muted);
    font-size: 0.9em;
    margin-bottom: 0.5em;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.75em;
    margin: 0.5em 0;
  }

  .label {
    min-width: 6em;
    font-weight: 600;
  }

  .path {
    flex: 1;
    font-family: var(--font-monospace);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5em;
    margin-top: 0.5em;
  }
</style>
