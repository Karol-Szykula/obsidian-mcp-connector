/**
 * Lazy accessor for `@huggingface/transformers`.
 *
 * A static import evaluates Transformers.js and onnxruntime-web while the
 * plugin module loads, before `onload` runs: about 33 ms and 9 MB of heap
 * that a session without semantic search never uses. A bundled `require()`
 * is resolved at build time, so it keeps working under Obsidian's
 * eval-based loader (a dynamic `import()` would 404), and it runs only on
 * the first call.
 */
type Transformers = typeof import("@huggingface/transformers");

let loaded: Transformers | undefined;

export function transformers(): Transformers {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- bundled require, evaluated on first use (see header)
  return (loaded ??= require("@huggingface/transformers") as Transformers);
}
