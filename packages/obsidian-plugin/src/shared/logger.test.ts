import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "./logger";
import { createMemoryLogFs } from "./log/memoryLogFs";

/**
 * The façade is the one place that supplies `console.warn` as the default
 * failure warning (ADR-0029 D6, D8). The README says that warning is the only
 * thing the plugin still prints to the developer console, once for each run of
 * failures. createLogger.test.ts injects its own `warn`, so nothing else
 * exercises the default wired here.
 */
describe("logger façade — the one console exception (OMC-062)", () => {
  const METHODS = ["log", "info", "warn", "error", "debug"] as const;
  type Spies = Record<(typeof METHODS)[number], ReturnType<typeof spyOn>>;
  let spies: Spies;

  beforeEach(async () => {
    await logger.close();
    spies = Object.fromEntries(
      METHODS.map((m) => [m, spyOn(console, m).mockImplementation(() => {})]),
    ) as Spies;
  });
  afterEach(async () => {
    await logger.close();
    for (const m of METHODS) spies[m].mockRestore();
  });

  test("a log file that cannot be written prints one console.warn for a whole run of failures", async () => {
    const fs = createMemoryLogFs({ failWrites: () => true });
    logger.configure({ dir: "/mem", level: "DEBUG", fs });

    for (let i = 0; i < 20; i += 1) {
      logger.info(`event ${i}`);
      await logger.flush();
    }

    expect(spies.warn).toHaveBeenCalledTimes(1);
    const message = String(spies.warn.mock.calls[0]?.[0]);
    expect(message.startsWith("MCP Connector: the diagnostic log")).toBe(true);
    for (const m of METHODS) {
      if (m !== "warn") expect(spies[m]).not.toHaveBeenCalled();
    }
  });

  test("a healthy log file prints nothing to the console, at any level", async () => {
    const fs = createMemoryLogFs();
    logger.configure({ dir: "/mem", level: "DEBUG", fs });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    await logger.flush();

    expect(fs.files.get("/mem/diagnostic.log")?.split("\n")).toHaveLength(5);
    for (const m of METHODS) expect(spies[m]).not.toHaveBeenCalled();
  });
});
