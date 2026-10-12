/*
 * R-13: every message the plugin emits goes through the logger façade, so the
 * diagnostic log is the one place a user finds it. A direct `console.` call
 * elsewhere would bypass the redactor and the level filter, which is the whole
 * point of ADR-0029 D8.
 *
 * This file lives outside `src/` on purpose, like link.test.ts: it reads the
 * source tree as text and is not plugin code. The allowed spot is the façade,
 * `src/shared/logger.ts`, which owns the one sanctioned `console.warn` default.
 * Test files and the generated sources under `assets/` are excluded.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const FACADE = ["shared", "logger.ts"].join(sep);
const CONSOLE_CALL = /\bconsole\s*\./;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "assets" || entry.name === "node_modules") continue;
      found.push(...sourceFiles(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".svelte")) &&
      !entry.name.endsWith(".test.ts")
    ) {
      found.push(full);
    }
  }
  return found;
}

/** `path:line` for every code line that calls into `console`. */
function consoleCalls(file: string): string[] {
  const hits: string[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const trimmed = line.trim();
      // Prose that mentions the console is not a call.
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        return;
      }
      if (CONSOLE_CALL.test(line)) {
        hits.push(`${relative(SRC, file)}:${index + 1}`);
      }
    });
  return hits;
}

describe("console routing (R-13)", () => {
  test("the scan sees the source tree", () => {
    const files = sourceFiles(SRC).map((f) => relative(SRC, f));
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(FACADE);
    expect(files.some((f) => f.endsWith(".svelte"))).toBe(true);
    expect(files.some((f) => f.includes(`${sep}assets${sep}`))).toBe(false);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });

  test("no `console.` call exists outside src/shared/logger.ts", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => relative(SRC, f) !== FACADE)
      .flatMap(consoleCalls);
    expect(offenders).toEqual([]);
  });
});
