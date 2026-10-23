/**
 * Resolves the folder-exclusion policy (ADR-0020 §D7, §D11).
 *
 * Read `mcpTools.excludedFolders` and compile it, with a fail-closed
 * posture that inverts this project's usual fail-open default
 * (ADR-0014 §1) for reasons §D7 spells out.
 *
 * Until 3.1.0 this class also carried the policy across `await`s in an
 * `AsyncLocalStorage` store, so a future per-token policy (phase 2) could
 * reach the guarded `App` without changing its signature. Phase 1 has one
 * vault-wide list, so that store only ever held the value
 * {@link PathPolicyProvider.vaultWide} already holds, and every read of it
 * went through `node:async_hooks` inside Obsidian's renderer, the
 * strongest lead on the Electron 43 blank window (#597, #609). It is gone; see the ADR-0020 §D11
 * amendment of 2026-10-23 for how phase 2 passes the policy instead.
 */
import {
  DENY_ALL_POLICY,
  compilePolicy,
  type PathPolicy,
} from "$/shared/pathPolicy";
import { SettingsStore } from "$/shared/settingsStore";
import { logger } from "$/shared/logger";
import type { PluginDataLike } from "$/shared/types";

/** The settings slice and key this provider reads. */
const SLICE = "mcpTools";
const FIELD = "excludedFolders";

/**
 * Resolves the vault-wide policy.
 *
 * One instance per plugin load. The policy it holds is vault-wide by
 * definition; phase 2 must not turn it into a per-token "current policy",
 * because two tokens interleaving at an `await` would read each other's
 * (ADR-0020 §D11).
 */
export class PathPolicyProvider {
  private readonly store: SettingsStore;

  /**
   * Starts at deny-all, not at "nothing excluded". Before the first
   * successful read there is no basis for believing any folder is safe
   * to serve, and the two failure directions are not symmetric: denying
   * wrongly looks like an empty vault and heals on the next read, while
   * serving wrongly discloses the file and cannot be undone.
   */
  private vaultWidePolicy: PathPolicy = DENY_ALL_POLICY;

  /**
   * True between a failed read and the next successful one. Exists only
   * so the error is logged once per transition rather than on every tool
   * call, which would bury it.
   */
  private failing = false;

  constructor(plugin: PluginDataLike, store?: SettingsStore) {
    this.store = store ?? new SettingsStore(plugin);
  }

  /**
   * Re-read the settings and return the policy now in force.
   *
   * On failure the previous policy is retained, which is what gives
   * §D7's escape hatch its effect without a special case: a vault whose
   * first successful read found no excluded folders keeps that empty
   * policy through any later read failure, so a user who never touched
   * the feature is never locked out by one.
   *
   * Never throws. A caller on the request path must not have to decide
   * what a thrown settings read means.
   */
  async refresh(): Promise<PathPolicy> {
    try {
      const slice = (await this.store.readSlice(SLICE)) as
        | Record<string, unknown>
        | undefined;
      this.vaultWidePolicy = compilePolicy(slice?.[FIELD]);
      if (this.failing) {
        this.failing = false;
        logger.warn(
          "Folder-exclusion policy: settings readable again, policy refreshed.",
        );
      }
    } catch (err) {
      if (!this.failing) {
        this.failing = true;
        logger.error(
          "Folder-exclusion policy: could not read settings; retaining the last known policy. " +
            "If no successful read has happened this session, every vault path is refused.",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
    return this.vaultWidePolicy;
  }

  /**
   * The vault-wide policy from the last successful read.
   *
   * What code that is not serving a request reads: the semantic indexer
   * and the prompts list-changed baseline. Both feed state shared by every
   * client, so neither may inherit a request's policy once phase 2 lets
   * those differ.
   */
  get vaultWide(): PathPolicy {
    return this.vaultWidePolicy;
  }

  /** True while settings reads are failing. Diagnostic only. */
  get isDegraded(): boolean {
    return this.failing;
  }

  /**
   * The policy for the request being served.
   *
   * Today the vault-wide policy, the same value {@link vaultWide} returns.
   * It stays a separate entry point so request paths and background tasks
   * remain distinguishable: phase 2 resolves a token's policy at the
   * dispatch point and hands it to the request explicitly (ADR-0020 §D11),
   * and every `current()` caller is a site that change has to visit. A
   * background task (a vault event handler, a timer, plugin load) reads
   * {@link vaultWide}.
   */
  current(): PathPolicy {
    return this.vaultWidePolicy;
  }
}

/**
 * One provider per plugin instance, created on first use.
 *
 * A `WeakMap` rather than a field on `McpToolsPlugin`: `shared/` must not
 * import the plugin class (the barrel already pulls in `src/main`, which
 * is why `settingsStore` takes a structural `PluginDataLike` instead).
 * Keying by the plugin object gives every composition root the same
 * provider without any of them having to thread it through a signature,
 * and a test's throwaway plugin gets its own.
 */
const providers = new WeakMap<object, PathPolicyProvider>();

export function pathPolicyFor(plugin: PluginDataLike): PathPolicyProvider {
  let provider = providers.get(plugin);
  if (!provider) {
    provider = new PathPolicyProvider(plugin);
    providers.set(plugin, provider);
  }
  return provider;
}
