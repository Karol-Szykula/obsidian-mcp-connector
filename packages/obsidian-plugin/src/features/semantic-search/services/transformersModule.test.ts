import { describe, expect, test } from "bun:test";
import { loadTransformers } from "./transformersModule";

describe("loadTransformers()", () => {
  test("resolves the library on demand and hands out the same module each time", async () => {
    const first = await loadTransformers();
    expect(typeof first.pipeline).toBe("function");
    expect(typeof first.env).toBe("object");
    expect(await loadTransformers()).toBe(first);
  });
});

// The point of the accessor: loading the plugin must not evaluate
// Transformers.js. Checked on the source, because a test process that has
// already imported it elsewhere cannot show absence at runtime.
describe("static imports of @huggingface/transformers", () => {
  test("only the lazy accessor names it", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const offenders = readdirSync(import.meta.dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => f !== "transformersModule.ts")
      .filter((f) =>
        /from\s+["']@huggingface\/transformers["']/.test(
          readFileSync(`${import.meta.dir}/${f}`, "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
