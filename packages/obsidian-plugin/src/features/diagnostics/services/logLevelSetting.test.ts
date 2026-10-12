import { describe, expect, spyOn, test } from "bun:test";
import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import {
  DIAGNOSTICS_SLICE,
  readLogLevel,
  writeLogLevel,
} from "./logLevelSetting";

/** A `data.json` double that records every save. */
function makePlugin(initial: unknown) {
  const state = { data: initial };
  const saves: unknown[] = [];
  const plugin: PluginDataLike = {
    loadData: async () => state.data,
    saveData: async (next: unknown) => {
      saves.push(next);
      state.data = next;
    },
  };
  return { plugin, saves, state };
}

describe("DIAGNOSTICS_SLICE", () => {
  test("the level lives in the `diagnostics` slice (ADR-0029 D7)", () => {
    expect(DIAGNOSTICS_SLICE).toBe("diagnostics");
  });
});

describe("readLogLevel (R-03)", () => {
  test("a missing slice reads as INFO", async () => {
    const { plugin, saves } = makePlugin({});
    expect(await readLogLevel(plugin)).toBe("INFO");
    expect(saves).toHaveLength(0);
  });

  test("a missing data.json reads as INFO", async () => {
    const { plugin, saves } = makePlugin(null);
    expect(await readLogLevel(plugin)).toBe("INFO");
    expect(saves).toHaveLength(0);
  });

  test("an undefined plugin reads as INFO", async () => {
    expect(await readLogLevel(undefined)).toBe("INFO");
  });

  test("an invalid stored value reads as INFO and is not rewritten", async () => {
    for (const logLevel of ["verbose", "debug", 3, null, ""]) {
      const { plugin, saves } = makePlugin({ diagnostics: { logLevel } });
      expect(await readLogLevel(plugin)).toBe("INFO");
      expect(saves).toHaveLength(0);
    }
  });

  test("a non-object slice reads as INFO and is not rewritten", async () => {
    for (const slice of ["loud", 5, null, true, ["DEBUG"]]) {
      const { plugin, saves } = makePlugin({ diagnostics: slice });
      expect(await readLogLevel(plugin)).toBe("INFO");
      expect(saves).toHaveLength(0);
    }
  });

  test("a valid stored level is returned as is", async () => {
    for (const logLevel of ["DEBUG", "INFO", "WARN", "ERROR"] as const) {
      const { plugin, saves } = makePlugin({ diagnostics: { logLevel } });
      expect(await readLogLevel(plugin)).toBe(logLevel);
      expect(saves).toHaveLength(0);
    }
  });

  test("reading never calls saveData, even when the slice is absent", async () => {
    const { plugin, saves } = makePlugin({ mcpTransport: { tokens: [] } });
    await readLogLevel(plugin);
    await readLogLevel(plugin);
    expect(saves).toHaveLength(0);
  });
});

describe("writeLogLevel (R-03)", () => {
  const mcpTransport = {
    tokens: [{ id: "tok_a", token: "x".repeat(43) }],
    eraCounters: { legacy: 4, modern: 1 },
  };
  const toolLoading = {
    profile: "all",
    promoted: ["search_vault_simple"],
    profiles: { tok_a: { profile: "all", promoted: [], allowed: null } },
  };

  test("goes through updateSlice on the diagnostics slice", async () => {
    const { plugin } = makePlugin({});
    const spy = spyOn(SettingsStore.prototype, "updateSlice");
    try {
      await writeLogLevel(plugin, "DEBUG");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe(DIAGNOSTICS_SLICE);
    } finally {
      spy.mockRestore();
    }
  });

  test("persists the level and returns it", async () => {
    const { plugin, saves, state } = makePlugin({});
    expect(await writeLogLevel(plugin, "WARN")).toBe("WARN");
    expect(saves).toHaveLength(1);
    expect(
      (state.data as { diagnostics: { logLevel: string } }).diagnostics,
    ).toEqual({ logLevel: "WARN" });
    expect(await readLogLevel(plugin)).toBe("WARN");
  });

  test("leaves mcpTransport and toolLoading deep-equal to before", async () => {
    const before = structuredClone({ mcpTransport, toolLoading });
    const { plugin, state } = makePlugin(structuredClone(before));
    await writeLogLevel(plugin, "ERROR");
    const after = state.data as Record<string, unknown>;
    expect(after.mcpTransport).toEqual(before.mcpTransport);
    expect(after.toolLoading).toEqual(before.toolLoading);
    expect(after.diagnostics).toEqual({ logLevel: "ERROR" });
  });

  test("makes no save when the value is unchanged", async () => {
    const { plugin, saves } = makePlugin({
      mcpTransport,
      diagnostics: { logLevel: "WARN" },
    });
    expect(await writeLogLevel(plugin, "WARN")).toBe("WARN");
    expect(saves).toHaveLength(0);
  });

  test("a changed value saves exactly once", async () => {
    const { plugin, saves } = makePlugin({
      diagnostics: { logLevel: "WARN" },
    });
    await writeLogLevel(plugin, "DEBUG");
    expect(saves).toHaveLength(1);
  });

  test("keeps the slice's other keys", async () => {
    const { plugin, state } = makePlugin({
      diagnostics: { logLevel: "WARN", future: { kept: true } },
    });
    await writeLogLevel(plugin, "DEBUG");
    expect((state.data as Record<string, unknown>).diagnostics).toEqual({
      logLevel: "DEBUG",
      future: { kept: true },
    });
  });
});
