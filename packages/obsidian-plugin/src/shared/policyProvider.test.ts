import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PathPolicyProvider } from "./policyProvider";
import type { PluginDataLike } from "./types";

/**
 * In-memory plugin data, with a switch to make `loadData` throw so the
 * fail-closed posture can be exercised. Mirrors settingsStore.test.ts's
 * `makePlugin`.
 */
function makePlugin(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  let failing = false;
  let reads = 0;
  const plugin: PluginDataLike = {
    loadData: async () => {
      reads++;
      if (failing) throw new Error("data.json unreadable");
      return structuredClone(data);
    },
    saveData: async (next: unknown) => {
      data = structuredClone(next as Record<string, unknown>);
    },
  };
  return {
    plugin,
    setFailing: (v: boolean) => {
      failing = v;
    },
    setFolders: (folders: unknown) => {
      data = { mcpTools: { excludedFolders: folders } };
    },
    reads: () => reads,
  };
}

const withFolders = (folders: unknown) => ({
  mcpTools: { excludedFolders: folders },
});

describe("PathPolicyProvider — resolution", () => {
  test("compiles the configured folders", async () => {
    const { plugin } = makePlugin(withFolders(["/Therapy/", "Finances"]));
    const policy = await new PathPolicyProvider(plugin).refresh();
    expect(policy.folders).toEqual(["Therapy", "Finances"]);
    expect(policy.isExcluded("Therapy/a.md")).toBe(true);
    expect(policy.isExcluded("Public/a.md")).toBe(false);
  });

  test("an absent slice resolves to a policy that excludes nothing", async () => {
    const { plugin } = makePlugin({});
    const policy = await new PathPolicyProvider(plugin).refresh();
    expect(policy.isEmpty).toBe(true);
    expect(policy.isExcluded("Therapy/a.md")).toBe(false);
  });

  test("an absent field resolves to a policy that excludes nothing", async () => {
    const { plugin } = makePlugin({ mcpTools: { maxTextOutputKB: 50 } });
    const policy = await new PathPolicyProvider(plugin).refresh();
    expect(policy.isEmpty).toBe(true);
  });

  // A hand-edited or downgrade-round-tripped data.json can hold anything.
  test("corrupt data resolves rather than throwing", async () => {
    for (const junk of [42, "Therapy", { a: 1 }, [null, 7, {}], ["../x", ""]]) {
      const { plugin } = makePlugin(withFolders(junk));
      const policy = await new PathPolicyProvider(plugin).refresh();
      expect(policy.isEmpty).toBe(true);
    }
  });

  test("reads on every refresh — no caching of its own", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(fixture.plugin);
    await provider.refresh();
    fixture.setFolders(["Finances"]);
    const policy = await provider.refresh();
    expect(policy.folders).toEqual(["Finances"]);
    expect(fixture.reads()).toBe(2);
  });
});

describe("PathPolicyProvider — fail-closed posture (ADR-0020 D7)", () => {
  // The single most important assertion in this file. Getting it
  // backwards means a folder is served while the settings are unreadable.
  test("before any successful read, every path is refused", () => {
    const { plugin } = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(plugin);
    expect(provider.vaultWide.isExcluded("Public/a.md")).toBe(true);
    expect(provider.vaultWide.isExcluded("anything.md")).toBe(true);
    expect(provider.vaultWide.isEmpty).toBe(false);
  });

  test("a failing first read leaves the deny-all posture in place", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    fixture.setFailing(true);
    const provider = new PathPolicyProvider(fixture.plugin);
    const policy = await provider.refresh();
    expect(policy.isExcluded("Public/a.md")).toBe(true);
    expect(provider.isDegraded).toBe(true);
  });

  test("a later failure retains the last known policy, not deny-all", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(fixture.plugin);
    await provider.refresh();

    fixture.setFailing(true);
    const policy = await provider.refresh();
    expect(policy.folders).toEqual(["Therapy"]);
    expect(policy.isExcluded("Therapy/a.md")).toBe(true);
    expect(policy.isExcluded("Public/a.md")).toBe(false);
  });

  // The escape hatch: someone who never configured a folder must not be
  // locked out of their own vault by a transient read failure.
  test("an empty policy survives a later failure, so nothing locks out", async () => {
    const fixture = makePlugin({});
    const provider = new PathPolicyProvider(fixture.plugin);
    await provider.refresh();

    fixture.setFailing(true);
    const policy = await provider.refresh();
    expect(policy.isEmpty).toBe(true);
    expect(policy.isExcluded("Public/a.md")).toBe(false);
  });

  test("recovers on the next successful read", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(fixture.plugin);
    fixture.setFailing(true);
    await provider.refresh();
    expect(provider.isDegraded).toBe(true);

    fixture.setFailing(false);
    const policy = await provider.refresh();
    expect(provider.isDegraded).toBe(false);
    expect(policy.folders).toEqual(["Therapy"]);
  });

  test("refresh never throws, however the read fails", async () => {
    const plugin: PluginDataLike = {
      loadData: async () => {
        throw new Error("boom");
      },
      saveData: async () => {},
    };
    const provider = new PathPolicyProvider(plugin);
    const policy = await provider.refresh();
    expect(policy.isExcluded("anything.md")).toBe(true);
  });
});

describe("PathPolicyProvider — current()", () => {
  test("current() is the vault-wide policy, never inert", async () => {
    const { plugin } = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(plugin);
    await provider.refresh();
    expect(provider.current().folders).toEqual(["Therapy"]);
    expect(provider.current().isExcluded("Therapy/a.md")).toBe(true);
    expect(provider.current()).toBe(provider.vaultWide);
  });

  test("current() follows a refresh across awaits", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(fixture.plugin);
    await provider.refresh();
    fixture.setFolders(["Finances"]);
    await new Promise((r) => setTimeout(r, 5));
    await provider.refresh();
    expect(provider.current().folders).toEqual(["Finances"]);
  });
});

/**
 * #597, #609: reads of an `AsyncLocalStorage` store are the strongest lead
 * on the Electron 43 blank window, and a phase-1 policy never needed one
 * (ADR-0020 §D11, amendment of 2026-10-23). Nothing the desktop bundle
 * ships may import `node:async_hooks` again. Headless runs in plain Node
 * and is excluded.
 */
describe("desktop bundle stays off node:async_hooks", () => {
  test("no runtime source outside src/headless imports it", async () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.{ts,svelte}").scan(root)) {
      if (rel.startsWith("headless/") || rel.includes(".test.")) continue;
      const text = await Bun.file(join(root, rel)).text();
      if (/["'](node:)?async_hooks["']/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
