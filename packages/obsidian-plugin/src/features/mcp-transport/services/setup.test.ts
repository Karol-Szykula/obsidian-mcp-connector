import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mockPlugin } from "$/test-setup";
import { setup, teardown, type McpTransportState } from "./setup";
import type McpToolsPlugin from "$/main";
import { PORT_RANGE } from "../constants";
import { captureLogLines } from "$/shared/log/logCapture";

/**
 * `mcpTransport.livePort` is the actually-bound port, written back after
 * every successful startup so the generated .mcpb (mcpbGenerator.ts) can
 * resolve it fresh at connect time instead of embedding a stale value.
 */

const active: McpTransportState[] = [];
afterEach(async () => {
  for (const s of active.splice(0)) await teardown(s);
});

function makePlugin(initialData: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initialData };
  const plugin = mockPlugin({
    loadData: async () => data,
    saveData: async (next: unknown) => {
      data = next as Record<string, unknown>;
    },
  } as Partial<McpToolsPlugin>);
  return { plugin, getData: () => data };
}

describe("setup — livePort persistence", () => {
  test("persists the actually-bound port as mcpTransport.livePort", async () => {
    const { plugin, getData } = makePlugin();
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    active.push(result.state);

    const slice = getData()?.mcpTransport as Record<string, unknown>;
    expect(slice.livePort).toBe(result.state.server.port);
    expect(typeof slice.bearerToken).toBe("string");
  });

  test("preserves the existing bearerToken when writing livePort", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(32) },
    });
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    active.push(result.state);

    const slice = getData()?.mcpTransport as Record<string, unknown>;
    expect(slice.bearerToken).toBe("a".repeat(32));
    expect(slice.livePort).toBe(result.state.server.port);
  });

  test("preserves the existing bearerToken and mirrors it into tokens[0]", async () => {
    const TOKEN = "a".repeat(43);
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: TOKEN },
    });
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    active.push(result.state);

    const slice = getData()?.mcpTransport as {
      bearerToken: string;
      tokens?: Array<{ token: string }>;
    };
    expect(slice.bearerToken).toBe(TOKEN);
    expect(slice.tokens?.[0]?.token).toBe(TOKEN);
  });

  test("livePort reflects a fallback port, not the first PORT_RANGE entry", async () => {
    // Occupy PORT_RANGE[0] ourselves so the test is deterministic in CI. If it is
    // already taken (e.g. a real Obsidian instance running on the dev
    // machine), that already satisfies the precondition — skip creating
    // our own blocker rather than fail on the double-bind.
    let blocker: Server | null = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker!.once("error", reject);
        blocker!.listen(PORT_RANGE[0], "127.0.0.1", () => resolve());
      });
    } catch {
      blocker = null;
    }
    try {
      const { plugin, getData } = makePlugin();
      const result = await setup(plugin);
      expect(result.success).toBe(true);
      if (!result.success) return;
      active.push(result.state);

      expect(result.state.server.port).not.toBe(PORT_RANGE[0]);
      const slice = getData()?.mcpTransport as Record<string, unknown>;
      expect(slice.livePort).toBe(result.state.server.port);
    } finally {
      if (blocker) {
        await new Promise<void>((resolve) => blocker!.close(() => resolve()));
      }
    }
  });
});

describe("setup — sticky livePort", () => {
  /** The last range port nothing listens on now (small TOCTOU window). */
  async function lastFreeRangePort(): Promise<number | null> {
    for (const port of [...PORT_RANGE].reverse()) {
      const probe = createServer();
      const free = await new Promise<boolean>((resolve) => {
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (free) {
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        return port;
      }
    }
    return null;
  }

  test("binds the vault's last live port before the rest of the range", async () => {
    const port = await lastFreeRangePort();
    expect(port).not.toBeNull();
    const { plugin } = makePlugin({ mcpTransport: { livePort: port } });
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    active.push(result.state);
    expect(result.state.server.port).toBe(port!);
  });

  test("an unloaded instance does not overwrite the livePort of its replacement", async () => {
    const port = await lastFreeRangePort();
    expect(port).not.toBeNull();
    // The reloaded instance listens on its port and published it, so the
    // stale instance binds another one
    const replacement = createServer();
    await new Promise<void>((resolve) =>
      replacement.listen(port!, "127.0.0.1", () => resolve()),
    );
    try {
      const { plugin, getData } = makePlugin({
        mcpTransport: { livePort: port },
      });
      const stale = await setup(plugin, () => true);
      expect(stale).toEqual({
        success: false,
        error: "The plugin was unloaded",
      });
      const slice = getData()?.mcpTransport as Record<string, unknown>;
      expect(slice.livePort).toBe(port!);
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    }
  });
});

/**
 * R-09: server start (with port), stop and a start failure are logged.
 * The lines are read back from an in-memory file system the logger is
 * configured onto, so they are what is actually written, after redaction.
 */
describe("diagnostic log — server lifecycle", () => {
  const LISTENING = "MCP Connector HTTP server listening";
  const { lines, has, named, written } = captureLogLines();

  test("start writes `listening` at INFO with the bound port, and never the bearer token", async () => {
    const { plugin } = makePlugin();
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    active.push(result.state);

    const listening = named(await lines((a) => has(a, LISTENING)), LISTENING);
    expect(listening).toHaveLength(1);
    expect(listening[0]?.level).toBe("INFO");
    expect(listening[0]?.fields.port).toBe(result.state.server.port);
    expect(written()).not.toContain(result.state.bearerToken);
  });

  test("teardown writes `stopped` at INFO with the port it released", async () => {
    const { plugin } = makePlugin();
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const port = result.state.server.port;

    await teardown(result.state);

    const STOPPED = "MCP Connector HTTP server stopped";
    const stopped = named(await lines((a) => has(a, STOPPED)), STOPPED);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.level).toBe("INFO");
    expect(stopped[0]?.fields).toEqual({ port });
  });

  test("a start failure keeps its ERROR line", async () => {
    // A fixed port that something else already holds: setup refuses to fall
    // back to the range and reports the failure.
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve()),
    );
    const busyPort = (blocker.address() as { port: number }).port;
    try {
      const { plugin } = makePlugin({ mcpTransport: { port: busyPort } });
      const result = await setup(plugin);
      expect(result.success).toBe(false);

      const FAILED = "MCP Connector failed to start HTTP server";
      const all = await lines((a) => has(a, FAILED));
      const failed = named(all, FAILED);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.level).toBe("ERROR");
      expect(String(failed[0]?.fields.error)).toContain("in use");
      expect(named(all, LISTENING)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
