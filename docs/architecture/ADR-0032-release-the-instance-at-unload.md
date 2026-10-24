# ADR-0032: Release what a plugin instance leaves in the renderer at unload

- **Status:** Accepted and implemented
- **Date:** 2026-10-24
- **Scope:** What the desktop plugin must release when Obsidian disables it: the arktype registry its bundle puts on the window, the ONNX sessions of the embedding models, and the smaller things that outlived an instance
- **Relates to:** [ADR-0020](/docs/architecture/ADR-0020-omc-040-vault-folder-exclusion.md) (the `AsyncLocalStorage` removal in 3.1.0, whose amendment this ADR corrects), [ADR-0029](/docs/architecture/ADR-0029-user-facing-diagnostic-log.md) (the log that unload drains last), [ADR-0031](/docs/architecture/ADR-0031-headless-mode.md) (headless runs in plain Node and shares the embedder)

## Context

On Obsidian 1.14 (Electron 43, Node 24) the window can go blank while this plugin loads (#597, #609).
3.1.0 removed `AsyncLocalStorage` from the plugin and the crash became rare, but it did not go away: on one Mac with Obsidian 1.14.5, toggling the plugin off and on, 3.1.0-alpha.2 crashed once in 200 reloads.
The 3.1.0 notes and the README described that remaining crash as "a failed V8 check on a background thread, cause not known".

The twelve renderer crash reports collected on 18 and 23 October (`Obsidian Helper (Renderer)-*.ips`) were then read with Electron's own breakpad symbol files for 43.7.7 (the 1.14.4 installer) and 43.8.3 (the 1.14.5 installer), matched by binary UUID.
The earlier readings, "near `inspector_enable_async_hooks`", "near c-ares and cppgc", were the nearest exported symbols of a stripped binary and were wrong.
The reports hold two signatures.

**Signature 1, ten reports, all on plugin 3.0.3.**
SIGSEGV raised by V8's fatal-error path: `V8FatalErrorCallback` ← `PushStackTraceAndDie` ← `LookupIterator::GetRootForNonJSReceiver`, "null prototype chain root", ← `Runtime_LoadIC_Miss` ← JavaScript ← a microtask ← `node::InternalMakeCallback` ← `LibuvStreamWrap::OnUvRead`, an incoming MCP request.
Node 24 keeps `AsyncLocalStorage` frames in V8's continuation-preserved embedder data and reads them back without a type check.
Blink stores a `CppHeapExternal` for task attribution in the same slot.
`frame?.has(this)` in `getStore` then loads a property off an object that is not a JavaScript receiver, and V8 stops the process.
Electron does not pass `--no-async-context-frame`, and a plugin cannot set it.
Two other Electron apps hit the same thing and fixed it the same way (smart-second-brain #481/#492, sulla-desktop #882).
3.1.0 closed this signature by dropping `AsyncLocalStorage` (ADR-0020, amendment of 2026-10-23).

**Signature 2, two reports: 3.0.3 after 2 h 13 min, and 3.1.0-alpha.2 after 150 reloads in one renderer in 14.5 min.**
SIGTRAP raised by `V8OOMErrorCallback`: "Allocation failed - JavaScript heap out of memory".
Electron builds V8 with pointer compression, so the JavaScript heap of a renderer is capped at 4 GB whatever the machine has.
This is not Electron's crash: something kept the heap growing with every reload.

The cause is in the bundle.
`@ark/schema`, the runtime of the `arktype` schema library, keeps every compiled validator's references (functions, regexes, nodes) in a registry object, assigns it to `globalThis` under `$ark` (or `$ark2`, `$ark3`, … when the name is taken) the first time it is evaluated, and never removes it.
Compiled validators reach it by that global name.
Obsidian evaluates `main.js` again on every enable and never unloads the previous evaluation's modules; only reachability decides what the garbage collector frees.
The registry makes the whole previous evaluation reachable: the plugin declares 247 schemas at module level, and the registry of one evaluation held 653 entries.
Measured on a build of 3.1.0 evaluated repeatedly in Node 22 against a stub of the Obsidian API: about 41 MB of heap retained per evaluation; 0 to 6 MB once `globalThis[registryName]` was deleted after each evaluation.
At 41 MB a reload, 100 reloads are 4 GB.
The console also showed arktype's own "Multiple @ark registries detected" warning on every reload, which is the same fact seen from the other side.

The audit of what else an unloaded instance leaves behind found four more things, none of them big enough to crash the renderer, all of them wrong:

- The MiniLM, EmbeddingGemma and multilingual-e5 pipelines were dropped by reference at unload and when the idle timer fired, but their ONNX sessions, which hold the model weights outside the JavaScript heap, were never released (`Pipeline.dispose()` in Transformers.js 4.2.0 calls `session.release()` on each).
- `onload` assigned `promptsState` after an `await` with no check that `onunload` had run meanwhile, so a prompts setup that finished late installed its vault listeners on a dead instance.
- The broker registration request went through Node's shared keep-alive `http.globalAgent`, and a `stop()` during a reconnection waited for the request's answer or its 2 s timeout.
- The `node --version` probe and the `npx mcp-remote` pre-warm (up to 120 s) were started with `promisify(execFile)` and nothing ended them at unload; their callbacks, and the instance they close over, lived until they exited.

Not found: no DNS or c-ares use (the plugin binds 127.0.0.1 only), no workers, no `process.on` handlers, no `FinalizationRegistry`.

## Decision

1. **The plugin removes its own arktype registry as the last step of unload.**
   `shared/arkRegistry.ts` finds the registry by identity, not by name: arktype's ambient scope exposes the `ambient` object of the registry its own `@ark/schema` copy created, and the `$ark*` global whose `ambient` is that object is this bundle's.
   A registry another plugin's copy of arktype created has a different one and is left alone.
   `onunload` runs the whole teardown in a `try`, and `releaseArkRegistry()` in its `finally`, after every `await`, because a compiled validator reaches the registry by its global name: nothing of the instance may run a schema after this point, and the teardown that precedes it already stops everything that could.
   A later evaluation of the bundle registers a new registry under the first free name.
   A unit test asserts that the lookup finds the registry, removes only it, and that arktype keeps working once it is back, so an arktype upgrade that changes the lookup fails the suite instead of silently leaking again.
2. **A dropped pipeline is disposed.**
   `PipelineFn` gains an optional `dispose`, the shape Transformers.js pipelines have, and `disposePipeline()` calls it best-effort.
   The embedder disposes the pipeline it drops at unload and at the idle timer, after the calls still in flight on it have finished (an in-flight counter; the idle timer re-arms instead of pulling a pipeline a batch is using), and a load that resolves after an unload disposes its pipeline instead of installing it.
   `EmbeddingProvider` gains an optional `unload()`; the Transformers.js provider implements it, and the semantic-search teardown calls it on every DLC provider before it unloads the embedder and closes the stores.
3. **A step of onload that finishes after onunload installs nothing.**
   The plugin keeps an `unloaded` flag, set first thing in `onunload`.
   The prompts setup checks it and tears its fresh state down when it is set, as the semantic wiring already did through `createSemanticWiring`.
4. **The registration request gets its own socket and can be aborted.**
   `connectRegistration` passes `agent: false` and an `AbortSignal`; `stop()` aborts the attempt in flight before it waits for the recovery loop.
5. **Child processes are tracked and ended at unload.**
   `childProcesses.ts` wraps `execFile` as `promisify(execFile)` did, remembers each child until it exits, and `killTrackedChildren()` sends SIGTERM to the rest.
   `onunload` calls it in its synchronous prefix.
   `brew install node` is not tracked: a half-finished install is worse than one that outlives the plugin.
6. **Rules for new code.**
   A module that puts anything on `globalThis` or `window` must also provide its release, called from `onunload`.
   A resource with a release method (an ONNX session, a socket, a child process) is released by the owner that created it, not dropped by reference.
   Any `await` in `onload` is followed by an `unloaded` check before the result is installed on the instance.

## Consequences

- A reload frees the previous instance.
  The field check is two lines in Obsidian's developer console before and after twenty toggles: `Object.keys(window).filter(k => k.startsWith("$ark")).length` should stay at the number of other plugins that use arktype plus one, and `process.memoryUsage().heapUsed` should return to about the same value.
  The "Multiple @ark registries detected" warning no longer appears on reload.
- The heap-OOM crash is explained by a measured leak and the fix removes the leak, but the confirmation that no other signature remains comes only from running the toggle loop on Electron 43 again.
  Until then the README says what was found and what was changed, not that the blank window is gone.
- Signature 1 stays fixed only as long as the plugin does not use `AsyncLocalStorage` or `AsyncResource` inside Obsidian.
  The test that keeps `node:async_hooks` out of the desktop bundle stands.
- Releasing the registry last means the ordering of `onunload` matters more than before: a teardown step that validated a schema after the `finally` would throw `ReferenceError` (name gone) or, after a fast re-enable, read the next instance's registry.
  Nothing does today; a new teardown step must stay inside `teardown()`.
- `agent: false` costs one socket per route instead of a pooled slot, for one long-lived connection per vault.
- Headless shares the embedder and gets the disposal for free; it never had the registry problem, since a Node process exits.
- The 3.1.0 changelog entry and ADR-0020's amendment of 2026-10-23 keep their text; this ADR is the correction.
