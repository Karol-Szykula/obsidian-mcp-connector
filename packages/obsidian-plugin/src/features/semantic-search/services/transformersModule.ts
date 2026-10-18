/**
 * Lazy loader for `@huggingface/transformers`.
 *
 * A static import evaluates Transformers.js and onnxruntime-web while the
 * plugin module loads, before `onload` runs: about 33 ms and 9 MB of heap
 * that a session without semantic search never uses. The bundler inlines
 * this `import()` into main.js and wraps the library in a lazy initialiser,
 * so nothing is fetched at runtime and the library runs on the first call.
 * A `require()` here would make the bundler pick the CommonJS build of the
 * library instead of the ES module build the B1 post-build step patches.
 */
type Transformers = typeof import("@huggingface/transformers");

let loading: Promise<Transformers> | undefined;

export function loadTransformers(): Promise<Transformers> {
  return (loading ??= import("@huggingface/transformers"));
}
