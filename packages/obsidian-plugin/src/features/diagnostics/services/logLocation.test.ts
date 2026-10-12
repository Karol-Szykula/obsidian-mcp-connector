import { describe, expect, test } from "bun:test";
import { FileSystemAdapter, type App, type PluginManifest } from "obsidian";
import { resolveLogLocation } from "./logLocation";

const BASE = "/Users/me/Vault";

const vaultAdapter = (base: string) =>
  Object.assign(new FileSystemAdapter(), { getBasePath: () => base });

function makePlugin(opts: {
  adapter: unknown;
  manifest?: Partial<PluginManifest>;
  configDir?: string;
}) {
  return {
    app: {
      vault: {
        adapter: opts.adapter,
        configDir: opts.configDir ?? ".obsidian",
      },
    } as unknown as App,
    manifest: {
      id: "mcp-tools-istefox",
      ...opts.manifest,
    } as PluginManifest,
  };
}

/** Maps the vault's symlinked spelling onto its real location. */
const realpath = async (path: string): Promise<string> =>
  path
    .replace("/Users/me/Vault", "/Volumes/Data/Vault")
    .replace("/Users/me", "/private/Users/me");

const deps = {
  homedir: () => "/Users/me",
  realpath,
  platform: () => "darwin",
};

describe("resolveLogLocation — directory (R-01)", () => {
  test("dir is the vault base path joined with manifest.dir", async () => {
    const plugin = makePlugin({
      adapter: vaultAdapter(BASE),
      manifest: { dir: ".obsidian/plugins/mcp-tools-istefox" },
    });
    const location = await resolveLogLocation(plugin, deps);
    expect(location?.dir).toBe(`${BASE}/.obsidian/plugins/mcp-tools-istefox`);
  });

  test("dir falls back to <configDir>/plugins/<id> when manifest.dir is absent", async () => {
    const plugin = makePlugin({
      adapter: vaultAdapter(BASE),
      configDir: ".config-obsidian",
    });
    const location = await resolveLogLocation(plugin, deps);
    expect(location?.dir).toBe(
      `${BASE}/.config-obsidian/plugins/mcp-tools-istefox`,
    );
  });

  test("an adapter that is not a FileSystemAdapter gives null", async () => {
    const plugin = makePlugin({
      adapter: { getBasePath: () => BASE },
      manifest: { dir: ".obsidian/plugins/mcp-tools-istefox" },
    });
    expect(await resolveLogLocation(plugin, deps)).toBeNull();
  });
});

describe("resolveLogLocation — redaction paths (R-06)", () => {
  test("paths carry the given and the realpath spelling of vault, plugin directory and home", async () => {
    const plugin = makePlugin({
      adapter: vaultAdapter(BASE),
      manifest: { dir: ".obsidian/plugins/mcp-tools-istefox" },
    });
    const location = await resolveLogLocation(plugin, deps);
    expect(location).not.toBeNull();
    const { paths } = location!;

    expect(paths.vault).toContain("/Users/me/Vault");
    expect(paths.vault).toContain("/Volumes/Data/Vault");

    const pluginDir = "/Users/me/Vault/.obsidian/plugins/mcp-tools-istefox";
    expect(paths.pluginDir).toContain(pluginDir);
    expect(paths.pluginDir).toContain(
      "/Volumes/Data/Vault/.obsidian/plugins/mcp-tools-istefox",
    );

    expect(paths.home).toContain("/Users/me");
    expect(paths.home).toContain("/private/Users/me");
  });

  test("when realpath changes nothing, the given spelling is still present", async () => {
    const plugin = makePlugin({
      adapter: vaultAdapter(BASE),
      manifest: { dir: ".obsidian/plugins/mcp-tools-istefox" },
    });
    const location = await resolveLogLocation(plugin, {
      ...deps,
      realpath: async (p) => p,
    });
    expect(location?.paths.vault).toContain(BASE);
    expect(location?.paths.home).toContain("/Users/me");
  });
});
