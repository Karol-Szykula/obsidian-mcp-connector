import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemAdapter } from "obsidian";
import type McpToolsPlugin from "$/main";
import { logger } from "$/shared/logger";
import { LOG_FILE_NAME } from "$/shared/log/logSink";
import { setup } from "./index";

/**
 * (coverage) `setup` is the only place the logger is pointed at a real
 * directory in the shipped build (R-01), seeded with the stored level (R-03)
 * and the configured secrets (R-05), and it must never fail the plugin load
 * (R-11). The behaviour is stated by ADR-0029 and the function's own
 * contract ("never throws"); these tests run it against a real temp
 * directory and the real Node file system.
 */

const SECRET = "Zq9-legacy+secret/with=symbols!and-more-than-32-bytes";
const PLUGIN_DIR_RELATIVE = ".obsidian/plugins/mcp-tools-istefox";

let vault: string;
let pluginDir: string;

function makePlugin(opts: { data?: unknown; adapter?: unknown } = {}) {
  const state = { data: opts.data };
  return {
    app: {
      vault: {
        adapter:
          opts.adapter ??
          Object.assign(new FileSystemAdapter(), {
            getBasePath: () => vault,
          }),
        configDir: ".obsidian",
      },
    },
    manifest: { id: "mcp-tools-istefox", dir: PLUGIN_DIR_RELATIVE },
    loadData: async () => state.data,
    saveData: async (next: unknown) => {
      state.data = next;
    },
  } as unknown as McpToolsPlugin;
}

async function logFile(): Promise<string> {
  await logger.flush();
  return readFile(join(pluginDir, LOG_FILE_NAME), "utf8");
}

beforeEach(async () => {
  await logger.close();
  vault = await mkdtemp(join(tmpdir(), "diag-setup-"));
  pluginDir = join(vault, PLUGIN_DIR_RELATIVE);
  await mkdir(pluginDir, { recursive: true });
});

afterEach(async () => {
  await logger.close();
  await rm(vault, { recursive: true, force: true });
});

describe("diagnostics setup (coverage)", () => {
  test("configures the logger onto <plugin dir>/diagnostic.log at the default level", async () => {
    await setup(makePlugin());

    expect(logger.getLogPath()).toBe(join(pluginDir, LOG_FILE_NAME));
    expect(logger.getLevel()).toBe("INFO");
    logger.info("setup wrote this");
    logger.debug("setup must not write this");

    const text = await logFile();
    expect(text).toContain("setup wrote this");
    expect(text).not.toContain("setup must not write this");
  });

  test("applies the level persisted in the diagnostics slice", async () => {
    await setup(makePlugin({ data: { diagnostics: { logLevel: "WARN" } } }));

    expect(logger.getLevel()).toBe("WARN");
    logger.info("below the stored level");
    logger.warn("at the stored level");

    const text = await logFile();
    expect(text).toContain("at the stored level");
    expect(text).not.toContain("below the stored level");
  });

  test("an invalid stored level behaves as INFO", async () => {
    await setup(makePlugin({ data: { diagnostics: { logLevel: "verbose" } } }));
    expect(logger.getLevel()).toBe("INFO");
  });

  test("seeds the redactor with the configured secrets before the first line", async () => {
    await setup(
      makePlugin({
        data: {
          mcpTransport: {
            tokens: [{ id: "abc", label: "x", token: SECRET, createdAt: 1 }],
          },
        },
      }),
    );

    logger.warn(`handing out ${SECRET}`, { token: SECRET });

    const text = await logFile();
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED:secret]");
  });

  test("replaces the vault's absolute path in a later line", async () => {
    await setup(makePlugin());
    logger.warn(`failed at ${join(vault, "Notes", "a.md")}`);

    const text = await logFile();
    expect(text).not.toContain(vault);
    expect(text).toContain("<vault>");
  });

  test("a vault without a file-system adapter leaves the logger unconfigured and does not throw", async () => {
    await expect(setup(makePlugin({ adapter: {} }))).resolves.toBeUndefined();
    expect(logger.getLogPath()).toBeNull();
  });

  test("an unreadable data.json still gives a log, at the default level, and does not throw", async () => {
    const plugin = makePlugin();
    (plugin as unknown as { loadData: () => Promise<never> }).loadData =
      async () => {
        throw new Error("data.json is evicted");
      };

    await expect(setup(plugin)).resolves.toBeUndefined();
    expect(logger.getLogPath()).toBe(join(pluginDir, LOG_FILE_NAME));
    expect(logger.getLevel()).toBe("INFO");
  });
});
