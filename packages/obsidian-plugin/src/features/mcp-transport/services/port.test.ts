import { describe, expect, test, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { bindWithFallback, resolvePorts } from "./port";
import { BROKER_PORT, PORT_RANGE } from "../constants";
import { captureLogLines } from "$/shared/log/logCapture";

const openServers: Server[] = [];

afterEach(async () => {
  for (const s of openServers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
});

// Bind to port 0 to let the OS assign a free ephemeral port, keep the
// server listening so the port remains occupied for the caller.
async function occupyFreePort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  openServers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, server };
}

describe("bindWithFallback", () => {
  test("binds to the first port in the range when free", async () => {
    // Occupy a port, release it, then immediately use it as the range.
    // Small TOCTOU window but acceptable for a unit test.
    const { port, server: blocker } = await occupyFreePort();
    await new Promise<void>((r) => blocker.close(() => r()));

    const server = createServer();
    openServers.push(server);
    const bound = await bindWithFallback(server, [port]);
    expect(bound).toBe(port);
  });

  test("falls back to the next port when the first is taken", async () => {
    const { port: p0 } = await occupyFreePort(); // p0 stays occupied
    const { port: p1, server: blocker1 } = await occupyFreePort(); // grab p1
    await new Promise<void>((r) => blocker1.close(() => r())); // free p1

    const server = createServer();
    openServers.push(server);
    const bound = await bindWithFallback(server, [p0, p1]);
    expect(bound).toBe(p1);
  });

  test("throws when all ports in range are taken", async () => {
    const { port: p0 } = await occupyFreePort();
    const { port: p1 } = await occupyFreePort();

    const server = createServer();
    openServers.push(server);
    await expect(bindWithFallback(server, [p0, p1])).rejects.toThrow(
      /no free port/i,
    );
  });

  test("throws immediately when a single fixed port is busy, no fallback (#337)", async () => {
    const { port } = await occupyFreePort();

    const server = createServer();
    openServers.push(server);
    await expect(bindWithFallback(server, [port])).rejects.toThrow(
      /no free port/i,
    );
  });
});

describe("resolvePorts", () => {
  test("returns the default range when unset", () => {
    expect(resolvePorts(undefined)).toEqual(PORT_RANGE);
  });

  test("returns a single-element list for a valid configured port", () => {
    expect(resolvePorts(27210)).toEqual([27210]);
  });

  test("falls back to the default range for an out-of-range port", () => {
    expect(resolvePorts(80)).toEqual(PORT_RANGE);
    expect(resolvePorts(70000)).toEqual(PORT_RANGE);
  });

  test("falls back to the default range for a non-integer or non-numeric value", () => {
    expect(resolvePorts(27200.5)).toEqual(PORT_RANGE);
    expect(resolvePorts("27200")).toEqual(PORT_RANGE);
    expect(resolvePorts(null)).toEqual(PORT_RANGE);
  });
});

describe("resolvePorts with the broker port and a last live port", () => {
  test("the dynamic range never includes the broker port", () => {
    expect(PORT_RANGE as readonly number[]).not.toContain(BROKER_PORT);
    expect(PORT_RANGE).toHaveLength(12);
    expect(PORT_RANGE[0]).toBe(27201);
    expect(PORT_RANGE[PORT_RANGE.length - 1]).toBe(27212);
  });

  test("tries the last live port first, then the rest of the range in order", () => {
    expect(resolvePorts(undefined, 27205)).toEqual([
      27205,
      ...PORT_RANGE.filter((port) => port !== 27205),
    ]);
  });

  test("ignores a last live port outside the range, including the broker port", () => {
    for (const livePort of [BROKER_PORT, 27213, 8080, "27205", null]) {
      expect(resolvePorts(undefined, livePort)).toEqual(PORT_RANGE);
    }
  });

  test("a fixed port wins over the last live port, and a legacy fixed broker port still loads", () => {
    expect(resolvePorts(27210, 27205)).toEqual([27210]);
    expect(resolvePorts(BROKER_PORT, 27205)).toEqual([BROKER_PORT]);
  });
});

/**
 * R-09: a port-bind failure is logged. The line is written on each
 * EADDRINUSE, at WARN, and the bind then carries on to the next port.
 */
describe("diagnostic log — port busy", () => {
  const BUSY = "MCP Connector HTTP server port busy";
  const { lines, has, named } = captureLogLines();

  test("an EADDRINUSE on the first port writes a WARN {port, code}, and the bind then succeeds on the next port", async () => {
    const { port: p0 } = await occupyFreePort();
    const { port: p1, server: blocker1 } = await occupyFreePort();
    await new Promise<void>((r) => blocker1.close(() => r()));

    const server = createServer();
    openServers.push(server);
    const bound = await bindWithFallback(server, [p0, p1]);
    expect(bound).toBe(p1);

    const busy = named(await lines((a) => has(a, BUSY)), BUSY);
    expect(busy).toHaveLength(1);
    expect(busy[0]?.level).toBe("WARN");
    expect(busy[0]?.fields).toEqual({ port: p0, code: "EADDRINUSE" });
  });

  test("one line per busy port, in order, when the whole list is taken", async () => {
    const { port: p0 } = await occupyFreePort();
    const { port: p1 } = await occupyFreePort();

    const server = createServer();
    openServers.push(server);
    await expect(bindWithFallback(server, [p0, p1])).rejects.toThrow(
      /no free port/i,
    );

    const busy = named(await lines((a) => named(a, BUSY).length >= 2), BUSY);
    expect(busy.map((l) => l.fields.port)).toEqual([p0, p1]);
  });

  test("a free first port writes no busy line", async () => {
    const { port, server: blocker } = await occupyFreePort();
    await new Promise<void>((r) => blocker.close(() => r()));

    const server = createServer();
    openServers.push(server);
    await bindWithFallback(server, [port]);

    expect(named(await lines(() => true), BUSY)).toEqual([]);
  });
});
