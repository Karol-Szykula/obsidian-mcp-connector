<script lang="ts">
  // The Access Control notice for tokens still on All tools (#625). It
  // only reads and dismisses: "Review and migrate" hands the token to the
  // Tool Loading panel, whose toggle stays the one writer of `profile`
  // (ADR-0025 D11, A8, and its #625 amendment).
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { createEventDispatcher } from "svelte";
  import {
    dismissMigrationNotice,
    readEverCalled,
    readEverCalledSince,
    readMigrationNoticeDismissed,
    readPolicy,
    type TokenPolicy,
  } from "../tokenPolicyStore";
  import {
    migrationNoticeEntries,
    type MigrationNoticeEntry,
    type MigrationNoticeToken,
  } from "../services/migrationNotice";

  export let plugin: McpToolsPlugin;
  export let tokens: MigrationNoticeToken[] = [];
  /** Bumped after any policy write, so the list re-reads. */
  export let revision = 0;

  const dispatch = createEventDispatcher<{ migrate: string }>();

  let entries: MigrationNoticeEntry[] = [];
  let busy = false;
  let reads = 0;

  // Re-read when the token list or a policy changes. Only while the
  // settings tab is open, never at load (Electron 43 rule).
  $: void refresh(tokens, revision);

  async function refresh(
    list: MigrationNoticeToken[],
    _revision: number,
  ): Promise<void> {
    const read = ++reads;
    try {
      const registry = plugin.mcpTransportState?.mcp.registry;
      const servedNames = registry
        ? registry
            .listAll()
            .filter((t) => t.enabled)
            .map((t) => t.name)
        : [];
      const policies: Record<string, TokenPolicy> = {};
      const everCalled: Record<string, string[]> = {};
      for (const token of list) {
        policies[token.id] = await readPolicy(plugin, token.id);
        everCalled[token.id] = await readEverCalled(plugin, token.id);
      }
      const [everCalledSince, dismissed] = await Promise.all([
        readEverCalledSince(plugin),
        readMigrationNoticeDismissed(plugin),
      ]);
      // A newer read started while this one awaited
      if (read !== reads) return;
      entries = migrationNoticeEntries({
        now: Date.now(),
        everCalledSince,
        servedNames,
        tokens: list,
        policies,
        everCalled,
        dismissed,
      });
    } catch {
      // A failed read hides the notice; the panel's toggle still works
      if (read === reads) entries = [];
    }
  }

  async function dismiss(tokenId: string): Promise<void> {
    busy = true;
    try {
      await dismissMigrationNotice(plugin, tokenId);
      entries = entries.filter((e) => e.tokenId !== tokenId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save tool loading settings: ${message}`);
    } finally {
      busy = false;
    }
  }
</script>

{#if entries.length > 0}
  <div class="mcp-migration-notice">
    <p class="mcp-migration-notice-title">
      {entries.length === 1 ? "A token" : `${entries.length} tokens`} could
      load fewer tools
    </p>
    <p class="mcp-migration-notice-description">
      These tokens still load every tool in each session, which costs the
      client context before any work starts. Adaptive keeps the core set and
      every tool the client has called, and any other tool comes back with
      activate_tool.
    </p>
    <ul>
      {#each entries as entry (entry.tokenId)}
        <li>
          <div class="mcp-migration-notice-row">
            <span>
              <strong>{entry.label}</strong>: {entry.activeAfter} tools
              instead of {entry.activeNow}
            </span>
            <span class="mcp-migration-notice-actions">
              <button
                type="button"
                class="mod-cta"
                disabled={busy}
                on:click={() => dispatch("migrate", entry.tokenId)}
              >
                Review and migrate
              </button>
              <button
                type="button"
                disabled={busy}
                on:click={() => void dismiss(entry.tokenId)}
              >
                Not now
              </button>
            </span>
          </div>
          <details>
            <summary>
              {entry.deactivated.length} tool{entry.deactivated.length === 1
                ? ""
                : "s"} would go inactive
            </summary>
            <p class="mcp-migration-notice-tools">
              {entry.deactivated.join(", ")}
            </p>
          </details>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .mcp-migration-notice {
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    padding: 0.5em 1em;
    margin-bottom: 1em;
    background: var(--background-secondary);
  }

  .mcp-migration-notice-title {
    font-weight: var(--font-semibold);
    margin: 0.25em 0;
  }

  .mcp-migration-notice-description,
  .mcp-migration-notice-tools {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .mcp-migration-notice ul {
    list-style: none;
    padding: 0;
  }

  .mcp-migration-notice li + li {
    margin-top: 0.75em;
  }

  .mcp-migration-notice-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5em;
  }

  .mcp-migration-notice-actions {
    display: flex;
    gap: 0.5em;
  }
</style>
