# ADR-0029 — User-facing diagnostic log: one redacting sink in the plugin directory

**Status:** Proposed, pending plan approval
**Date:** 2026-10-11
**Chain:** `diagnostic-log`
**SPEC:** `SPEC.md` (repo root, Approved 2026-10-10), requirements R-01 … R-14
**Plan:** `docs/plans/diagnostic-log.md`
**Relates to:** ADR-0016 (era classification point and counters, observed and not moved), ADR-0017 (the
`promptsListChanged` era discriminant reused for the tool-call event), ADR-0014 and ADR-0025 (settings
slices, untouched: the level lives in a new slice)
**Supersedes:** nothing

---

## Context

Today `$/shared/logger` is `console` in the shipped build and, in development, a file appender from
`packages/shared` that writes to the OS log directory. A user reporting a broken client, a failing
tool or a protocol fallback has nothing to attach. The SPEC fixes the product decisions: one sink in
the plugin directory for development and production alike, JSON lines, 5 MB × 5 rotation, a persisted
level (default INFO), tool arguments as key names only, and redaction centralised in the sink. Those
are registered here, not reopened.

Two questions the SPEC left to the plan are settled here: the exact token-shaped redaction patterns,
and whether the logger stays in `packages/shared`. A third question surfaced during design: the sink
cannot redact a tool argument value, because it never sees the arguments. That needs a decision too.

### Facts this ADR rests on (checked 2026-10-11 against the working tree at `6752954`)

1. `packages/shared/src/logger.ts` exports `createLogger`, `loggerConfigMorph`, `getLogFilePath`,
   `logLevelSchema`, `LogLevel`, `InputLoggerConfig` and `FullLoggerConfig`. Exactly one file imports
   any of them: `packages/obsidian-plugin/src/shared/logger.ts`. The workspace has two packages. The
   `.mcpb` shim (`scripts/connectorShim.js`) and the root `scripts/` import nothing from `shared`.
2. The current facade picks `console` when `NODE_ENV === "production"`, else the shared appender
   writing to `~/Library/Logs/Claude/obsidian-plugin-mcp-tools.log` (per-OS variants) at DEBUG. So a
   `bun test` run today appends to the developer's OS log directory.
3. There are 82 `logger.*` call sites (tests included), all of the shape `(string, object?)`. None
   uses `fatal`, `flush`, `config` or `meta`. Three `console.*` calls remain in plugin `src/`:
   `CopyConfigMenu.svelte:132`, `AdaptiveToolLoadingSettings.svelte:250`, `shared/index.ts:134`.
4. Token format. `generateToken()` is `randomBytes(32).toString("base64url")`: exactly 43 characters
   of `[A-Za-z0-9_-]`, no padding, unchanged since `21e2029`. `generateTokenId()` is 9 bytes, so
   12 characters. `isUsableSecret` accepts a stored legacy secret of any charset at 32 or more UTF-8
   bytes. The broker access token is also `generateToken()`. Route ids are `randomUUID()`.
5. ArkType 2.0.0-rc.30 (`@ark/schema/out/shared/implement.js:85`) formats a default problem as
   `must be ${expected} (was ${actual})`, where `actual` is the offending value. `formatMcpError`
   turns that summary into the message the tool dispatcher logs at ERROR. A validation failure
   therefore logs tool argument values today.
6. Two existing call sites log what the SPEC forbids. `searchAndReplace.ts:70` logs `pattern`,
   `flags` and the `RegExp` error text, which embeds the pattern. `chunker.ts:291` logs a note
   `heading`, which is note content.
7. `@modelcontextprotocol/server` 2.3.0 exports `PROTOCOL_VERSION_META_KEY` and
   `SUPPORTED_PROTOCOL_VERSIONS`.
8. The `obsidian` 1.13.1 typings declare no show-in-folder API. The plugin already reaches Electron
   through the host `require` binding (`mcpbDownload.ts`, `electronDialog`).
9. `.gitignore` ignores `data.json` and `embeddings/` at the repo root but no `*.log`: its `_.log`
   line is a mangled pattern. `scripts/link.ts` makes the repo root the plugin directory in
   development, so an unignored log file would show up as untracked there.

## Decision

### D1 — One sink: a JSON-lines file in the plugin directory, in development and production (R-01, R-02)

This registers the SPEC decision. The file is `<vault>/<plugin dir>/diagnostic.log`. Rotated files are
`diagnostic.1.log` … `diagnostic.4.log`, `.1` being the newest. The plugin directory is
`manifest.dir`, falling back to `<configDir>/plugins/<id>`, joined to `FileSystemAdapter.getBasePath()`.
It is the same resolution `productionWiring.ts` already uses for `embeddings/`. The `NODE_ENV` branch
and the OS log directory are retired.

Each line is `{"timestamp": ISO-8601, "level", "message", "fields": {...}}` followed by `\n`.
`fields` sits under its own key so a call site's own `message` field cannot collide with the
top-level one. An `Error` anywhere in `fields` serialises as `{name, message, stack, code?}`, so the
stack stays on the same line. A field that cannot be serialised (circular, `bigint`, a throwing getter)
becomes the placeholder `"[unserializable]"`, and the line is still written.

The logger is unconfigured until `onload` calls `configure()`. Before that it holds at most 1,000 raw
entries and formats them at configuration time, so path redaction applies to them too. An unconfigured
logger never touches the file system, which also ends the test suite's writes into the developer's OS
log directory.

### D2 — The implementation moves into the plugin, and `packages/shared` loses its logger (settles SPEC "Not yet specified" #2)

The pure core goes to `packages/obsidian-plugin/src/shared/log/`: `logLine.ts`, `redact.ts`,
`logSink.ts`, `nodeLogFs.ts` and `createLogger.ts`. The singleton facade stays at
`src/shared/logger.ts`, so all 27 importing files and the `$/shared` barrel keep their import path.
`packages/shared/src/logger.ts` is deleted, along with its `export *` line.

The reason is fact 1: the shared logger has one consumer, and that consumer is the plugin. The new sink
also needs things only the plugin has: the plugin directory, the token secrets, the settings slice and
the vault path. Keeping the code in `shared` would mean injecting all of them across a package
boundary that nothing else uses. The pure core still takes its file system and clock as parameters
(test seam 1), so moving it back costs a file move if a second consumer ever appears.

The facade must not import `SettingsStore`, the token store or `main`, all of which import the logger.
Wiring flows the other way: the diagnostics feature pushes configuration, level and secrets into the
logger.

### D3 — Central redaction: fixed patterns, fixed order, applied to every string before serialisation (R-05, R-06; settles SPEC "Not yet specified" #1)

The sink scrubs every string it is about to serialise: the message, every field value at any depth,
object keys, array elements, error messages and stacks. Scrubbing runs on raw strings rather than on
the serialised JSON. That way a Windows path is matched before JSON escapes its backslashes, and no
replacement can break the JSON. The rules run in this order:

1. **Known secrets.** Every configured token secret is replaced by `[REDACTED:secret]`, as an exact
   substring. The token store registers secrets each time it reads or writes the token list
   (`readTokens`, `withTokens`). The diagnostics setup seeds them by reading the list once before
   `configure()`. Within a session the set only grows, so a secret that was regenerated or revoked a
   moment ago is still scrubbed from an error message still in flight. Strings shorter than 32 UTF-8
   bytes (`MIN_SECRET_BYTES`, the `isUsableSecret` floor) are never registered: a degenerate short
   secret would otherwise scrub common substrings everywhere. This rule is what covers a legacy secret
   that is not in generator format (fact 4).
2. **Authorization scheme.** `/\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi` becomes `$1 [REDACTED:token]`.
   It uses the RFC 6750 `b64token` alphabet, so any bearer credential is caught whatever its format.
3. **Token-shaped runs.**
   `/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g` becomes `[REDACTED:token]`. It is derived
   from the generator, which emits 43 base64url characters. The bound is "43 or more", not exactly 43,
   so a token glued to neighbouring identifier characters is still caught. It catches tokens this
   process never saw: another vault's token behind the shared broker, a token revoked in an earlier
   session, a token echoed in `mcp-remote` stderr, and the broker access token. A token id (12
   characters) and a route UUID (segments of 12 or fewer) stay below the bound and survive. The tool-call
   event needs the token id (R-07).
4. **Absolute paths.** The plugin directory becomes `<plugin>`, the vault base path `<vault>` and the
   home directory `<home>`. Each path is matched as given and as its `realpath`, because the plugin
   folder is often a symlink (development link, synced folders, 3.0.1's regression). On Windows both
   separator spellings are matched. Longest match first, so a path inside the vault reads
   `<vault>/.obsidian/...` rather than `<home>/...`.

Scrubbing happens before truncation. Truncating first could cut a secret into a fragment the patterns
no longer match. The bounds: a string is pre-capped at 65,536 characters, dropping a trailing base64url
run at the cut so no token fragment survives it. It is then scrubbed and capped at 8,192 characters
(`MAX_STRING_CHARS`). A line stays at or under 65,536 bytes (`MAX_LINE_BYTES`). If it would not, `fields`
is replaced by `{"truncated": true, "originalBytes": n}`. The line therefore stays valid JSON and far
below the rotation threshold.

### D4 — One sanctioned call-site scrub: tool argument values on the tool-error path (R-05, R-10)

The sink never sees tool arguments, so it cannot remove their values from an error message (fact 5).
Only one place holds both the arguments and the error text: the tool dispatcher's `catch` in
`toolRegistry.ts`. It applies `scrubArgumentValues(text, args)` to the message and the stack before
logging, by two rules:

- Every string leaf of the arguments of 4 characters or more (`MIN_ARG_VALUE_CHARS`), searched to a
  bounded depth and also in its `JSON.stringify` spelling, is replaced by `[REDACTED:arg]`.
- ArkType's ` (was …)` suffix at the end of each summary line is collapsed to ` (was [REDACTED:arg])`.

The ERROR line keeps `tool`, `errorCode` and the scrubbed `{name, message, stack}`. It drops the raw
`error` object and the `...formattedError` spread, whose `data` can carry an arbitrary thrown value.
The response returned to the client is built from the unscrubbed `formattedError` exactly as before
(R-10).

The logged `errorCode` is not always the response's code. An ArkType validation failure of the tool's
arguments is logged as `invalid_params`, while the response keeps `internal_error`: `schema.assert()`
throws an `AggregateError` of `ArkError`s, which `formatMcpError` maps to `InternalError`, and R-10
forbids changing that. The log diverges on purpose, because the operator reading it needs to tell a
caller's mistake (bad arguments) from a fault in the handler, and `internal_error` names both. The
override lives in `isValidationFailure` and touches only the log line.

The two call sites in fact 6 change in the same spirit. `search_and_replace` logs neither the pattern
nor the flags, and its `RegExp` error text goes through `scrubArgumentValues`. The chunker logs the
heading's length instead of its text.

This is a deliberate deviation from "redaction only in the sink". It is recorded so nobody "fixes" it
by moving the scrub into the sink, where the values are unknown.

### D5 — Request events observe after classification and never move it (R-07, R-08)

- **Tool call.** Each `tools/call` emits `"mcp tool call"` at INFO from the `tools/call` handler
  inside `buildMcpServer`. That handler is the single construction site both eras pass through. The
  event carries `method`, `tool`, `argKeys`, `outcome` (`ok`, `tool_error`, `inactive_tool` or
  `rejected`), `durationMs`, `tokenId` and `era`. The era comes from `buildMcpServer`'s existing second
  parameter, which ADR-0017 already made the era discriminant (`true` only on the modern factory). The
  signature does not change. The event is written in a `finally`, so a throw before dispatch is logged
  as `rejected` and then propagates unchanged.
- **Every request.** `handleRequest` emits `"mcp request"` after `recordEra`, never before it. Its
  fields are `method`, `era`, `requestedVersion`, `tokenId`, `status` and `durationMs`. The level is
  DEBUG, or INFO when the HTTP status is 400 or higher. That covers `tools/list`, `server/discover`
  and `initialize` at DEBUG, and every error at INFO. `requestedVersion` is the
  `mcp-protocol-version` header, else the `_meta[PROTOCOL_VERSION_META_KEY]` envelope claim, else
  `initialize`'s `params.protocolVersion`, truncated to 64 characters.
- **Version rejections.** A rejected protocol version emits `"mcp protocol version rejected"` at WARN
  with `requested` and `rung`, at each of the three places one is answered. `middleware` is the
  pre-2026 400 in `httpServer.ts`, before auth, so it has no token id. `deferred` is
  `applyDeferredVersionRung` in `handleRequest`. `sdk` covers a modern request answered 400 whose
  requested version is not in the project-owned `SUPPORTED_PROTOCOL_VERSIONS`
  (`mcp-transport/constants.ts`), which spans both eras. The SDK's export of the same name is the
  wrong comparand: it lists legacy revisions only and keeps the modern ones in a separate
  `SUPPORTED_MODERN_PROTOCOL_VERSIONS`, so a supported 2026-era version would read as rejected. Each rejected request produces
  exactly one line: the WARN replaces the INFO request line rather than adding to it.
- **Middleware refusals** (401, 403, 404, 405) and the 413 over-cap path emit one INFO `"mcp request"`
  each, with `status` and `reason` and no token id. Nothing is read from the headers apart from the
  version. The URL is never logged.

None of this reads or writes the response. The logger's methods are synchronous enqueues that never
throw, so the era counters and every response byte stay as they are (ADR-0016).

### D6 — Failure episodes: drop, pause, warn once, resume (R-11)

All writes, rotations, tails and clears run on one serialised queue. Rotation therefore never runs
twice at once, and lines are never interleaved or split. The current size is tracked in memory and
re-checked with `stat` before a rotation. A rotation removes `.4`, shifts `.3` through `.1` up by one
and moves the current file to `.1`, ignoring `ENOENT` at each step.

When a write fails, a failure episode opens. The failed batch is dropped, not retried. Exactly one
`console.warn` is emitted for the episode, and writes pause for 30 seconds (`FAILURE_PAUSE_MS`), with
dropped lines counted. After the pause, the next event triggers one attempt. Nothing runs on a timer,
so nothing can retry in a tight loop. A successful write closes the episode and logs
`"diagnostic log resumed"` at WARN with `droppedLines`. Unload calls `close()`, which drains the
queue best-effort and detaches the sink. `onunload` is never awaited by Obsidian, so this does not
block it.

### D7 — The level lives in a new `diagnostics` slice (R-03)

The level is stored as `diagnostics.logLevel`, read through `SettingsStore.readSlice` and written
through `updateSlice`, which returns NO_CHANGE when the value is equal. A missing or invalid value
resolves to INFO, and reading never writes. The slice key is new, so `mcpTransport`, `toolLoading`,
the legacy mirror and ADR-0014/ADR-0025's write ordering are untouched. The settings section first
persists the level, then calls `logger.setLevel`, which applies it at once.
`"diagnostic log level changed"` and `"diagnostic log cleared"` are written whatever the current
level, so a reader can always tell why lines are missing or why the file is short.

### D8 — No console mirror (explicit "no")

Apart from D6's one warning per failure episode, the logger writes nothing to the developer console,
in any build. A WARN/ERROR mirror to `console` was considered and rejected; see A5.

## Alternatives considered

### A1 — Redaction at each call site (rejected; SPEC decision, registered)

There are 82 call sites today, plus the new ones, and any one of them can forget. The SPEC rejected
this. D4 is the single, bounded exception, and only because the sink cannot know argument values.

### A2 — Keep the logger in `packages/shared` and inject the plugin facts (rejected)

This keeps a package-level abstraction with one consumer, plus an ArkType config morph whose only job
was resolving the OS log directory. Every plugin fact the sink needs would cross the package boundary
as an injected dependency. The cost would only make sense if a second consumer existed, and none does
(fact 1). The shim runs in another process and is out of scope.

### A3 — Token-shaped pattern requiring mixed character classes (rejected)

Requiring at least one digit and one uppercase letter would spare long kebab-case file names and hex
hashes. But a uniformly random 43-character base64url string has no digit with probability
(54/64)^43 ≈ 0.07 %, and that case would leak an unknown token. The two failure modes are not
symmetrical: over-redaction makes one line less useful, under-redaction publishes a credential in an
issue. The plain length rule wins.

### A4 — One request line from `handleRequest`, with the tool outcome passed through a side channel (rejected)

A single line per request is tidier. But the modern factory runs inside the SDK. Getting the
handler's outcome back out would mean relying on `AsyncLocalStorage` surviving the SDK's internals,
or on the SDK forwarding an `AuthInfo.extra` object untouched. Neither is a documented guarantee of
`@modelcontextprotocol/server` 2.3.0. Emitting from the handler, which is shared by both eras, is
explicit and costs only a DEBUG line's worth of duplication.

### A5 — Mirror WARN and ERROR to the developer console (rejected)

Today's production `console` output would survive for anyone who reads DevTools. But that is a second
sink, which the SPEC's single-sink decision excludes. It would also print unredacted objects that
DevTools renders lazily, unless the mirror re-implemented the scrub. The README's troubleshooting text
points at the console today. D1's log file replaces it, and the documentation changes with it.

### A6 — Vault-relative note paths or redacted full values for tool arguments (rejected; SPEC decision, registered)

Note names are user content and would travel with every attached log. Free text cannot be redacted
reliably. Arguments are logged by key name only.

## Consequences

### Positive

- A user can attach one bounded, greppable file to an issue, and development exercises the code path
  users run.
- A token never reaches the file by construction. Every string passes the same scrub, whichever call
  site produced it, and argument values are removed at the one place they can be.
- Transport, era and tool problems are visible at the default level without DEBUG: one INFO line per
  tool call, one per error.
- The test suite stops writing into the developer's OS log directory (fact 2).

### Negative

- The developer console no longer shows plugin errors in the shipped build. Anyone used to reading it
  has to open the log instead, and the README must say so.
- Over-redaction. A file name segment, hash or identifier of 43 or more base64url characters is
  replaced by `[REDACTED:token]`.
- A tool argument value shorter than 4 characters can survive inside an error message written by a
  tool handler. The bound exists because scrubbing every short string would wreck stacks.
- Vault-relative note paths still appear in the lines some existing call sites write
  (`find_broken_links`, `find_orphaned_notes`, the indexer's failure lines). R-06 allows the
  vault-relative form, but note names are user content.
- Polling clients with a bad token write one INFO line per request. Rotation bounds the disk use, not
  the history it pushes out.
- When the vault syncs (iCloud and the like), the log syncs with it. Two machines on one synced vault
  produce sync-conflict copies of `diagnostic.log`. The SPEC accepts this consequence.

### Neutral

- `packages/shared` keeps `arktype` for its prompt types and loses only the logger.
- The tool-call event's era depends on ADR-0017's `promptsListChanged` discriminant. A future factory
  that builds a modern instance with `false` would mislabel the era in the log, but serve nothing
  differently.

## References

- `SPEC.md` — `## Decisions`, `## Constraints`, `## Test seams`, `## Not yet specified`
- ADR-0014 §7 (legacy mirror), ADR-0016 §1 and §8 (classification point, era counters), ADR-0017
  (era discriminant), ADR-0025 (slice write ordering)
- `packages/obsidian-plugin/src/features/mcp-transport/services/token.ts`, `tokenStore.ts`
  (`isUsableSecret`, `readTokens`, `withTokens`)
- `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts` (`buildMcpServer`,
  `handleRequest`), `httpServer.ts`, `eraRouter.ts`, `toolRegistry.ts` (dispatcher `catch`)
- `node_modules/@ark/schema/out/shared/implement.js:85` (ArkType 2.0.0-rc.30 problem format)
- No brainstorm exists for this feature. The repository's `BRAINSTORM.md` concerns issue #445 and was
  deliberately not used.
