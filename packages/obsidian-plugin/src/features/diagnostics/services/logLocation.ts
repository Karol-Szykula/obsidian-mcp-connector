/**
 * Where the diagnostic log lives, and which absolute paths to redact
 * (ADR-0029 D1, D3).
 *
 * The directory is the plugin's own, resolved the way `productionWiring.ts`
 * resolves `embeddings/`: `manifest.dir`, else `<configDir>/plugins/<id>`,
 * joined to the vault base path. Each redaction path is listed as given and
 * as its realpath, because the plugin folder is often a symlink.
 */

import { homedir as _homedir } from "os";
import { realpath as _realpath } from "fs/promises";
import { FileSystemAdapter, type App, type PluginManifest } from "obsidian";
import type { RedactionPaths } from "$/shared/log/redact";

// Node builtins behind locally declared signatures: the community-plugin
// scanner type-checks without @types/node, so the bare imports resolve as
// `any` there and every call trips the no-unsafe-* rules.
const nodeHomedir = _homedir as () => string;
const nodeRealpath = _realpath as (path: string) => Promise<string>;

export type LogLocation = { dir: string; paths: RedactionPaths };

type LocationDeps = {
  homedir: () => string;
  realpath: (path: string) => Promise<string>;
  platform: () => string;
};

const defaultDeps: LocationDeps = {
  homedir: nodeHomedir,
  realpath: nodeRealpath,
  platform: () => process.platform,
};

export async function resolveLogLocation(
  plugin: { app: App; manifest: PluginManifest },
  deps: LocationDeps = defaultDeps,
): Promise<LogLocation | null> {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return null;

  const vault = adapter.getBasePath();
  const relative =
    plugin.manifest.dir ??
    `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  const dir =
    deps.platform() === "win32"
      ? `${vault}\\${relative.replace(/\//g, "\\")}`
      : `${vault}/${relative}`;

  const spellings = async (path: string): Promise<string[]> => {
    try {
      const real = await deps.realpath(path);
      return real === path ? [path] : [path, real];
    } catch {
      return [path];
    }
  };

  let home: string[] = [];
  try {
    home = await spellings(deps.homedir());
  } catch {
    // No home directory: nothing to redact for it.
  }

  return {
    dir,
    paths: {
      vault: await spellings(vault),
      pluginDir: await spellings(dir),
      home,
    },
  };
}
