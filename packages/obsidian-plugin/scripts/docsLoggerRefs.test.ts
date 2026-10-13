/*
 * OMC-062 regression guard: the docs must describe the logger where it
 * actually lives.
 *
 * `docs/project-architecture.md` listed `packages/shared/src/logger.ts` as the
 * "Shared logger" after that file was deleted, and the README's console
 * sentence omitted the one `console.warn` the façade still makes. Both are
 * statements about the tree and the code, so the suite can check them.
 *
 * Like consoleRouting.test.ts this file lives outside `src/` on purpose: it
 * reads repository files as text and is not plugin code.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const ARCHITECTURE = readFileSync(
  join(REPO, "docs", "project-architecture.md"),
  "utf8",
);
const README = readFileSync(join(REPO, "README.md"), "utf8");

/** The first fenced block under `### Package Organization`. */
function packageTree(): string[] {
  const start = ARCHITECTURE.indexOf("### Package Organization");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = ARCHITECTURE.indexOf("```", start);
  const close = ARCHITECTURE.indexOf("```", open + 3);
  expect(open).toBeGreaterThan(start);
  expect(close).toBeGreaterThan(open);
  return ARCHITECTURE.slice(open, close).split("\n").slice(1);
}

/**
 * Every entry of the tree as a repo-relative path. Depth comes from the
 * column of the branch glyph (four columns per level); the text after `#` is
 * a comment.
 */
function treePaths(lines: string[]): string[] {
  const stack: string[] = [];
  const paths: string[] = [];
  for (const line of lines) {
    const match = /^([│ ]*)[├└]── (\S+)/.exec(line);
    if (match === null) continue;
    const depth = (match[1] ?? "").length / 4;
    const name = (match[2] ?? "").replace(/\/$/, "");
    stack.length = depth;
    stack[depth] = name;
    paths.push(stack.join("/"));
  }
  return paths;
}

describe("project-architecture.md package tree (OMC-062)", () => {
  const paths = treePaths(packageTree());

  test("the parser sees the tree", () => {
    expect(paths).toContain("packages/obsidian-plugin/src/main.ts");
    expect(paths).toContain("packages/shared/src/index.ts");
  });

  test("every path the tree names exists in the repository", () => {
    const missing = paths.filter((p) => !existsSync(join(REPO, p)));
    expect(missing).toEqual([]);
  });

  test("the deleted shared logger is not listed, and the diagnostic logger directory is", () => {
    expect(paths.some((p) => p.endsWith("logger.ts"))).toBe(false);
    expect(
      existsSync(join(REPO, "packages", "shared", "src", "logger.ts")),
    ).toBe(false);
    expect(paths).toContain("packages/obsidian-plugin/src/shared/log");
  });
});

describe("README console sentence (OMC-062)", () => {
  test("it names the one exception: the log file that cannot be written", () => {
    const sentence = README.split("\n").find((l) =>
      l.includes("developer console"),
    );
    expect(sentence).toBeDefined();
    expect(sentence).toMatch(/exception/i);
    expect(sentence).toMatch(/cannot be written/);
    expect(sentence).toMatch(/single warning/);
  });
});
