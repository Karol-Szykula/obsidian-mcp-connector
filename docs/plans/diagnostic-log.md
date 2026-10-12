**Requirement set:** `SPEC.md`

# Implementation plan — User-facing diagnostic log for the plugin

**SPEC:** `SPEC.md` (repo root, Approved 2026-10-10), R-01 … R-14
**ADR outcome:** new ADR, `docs/architecture/ADR-0029-user-facing-diagnostic-log.md` (status
Proposed, pending this plan's approval). It qualifies on all three counts: hard to reverse, surprising
without context and a real trade-off. It also carries the security-boundary override: a bearer token
must never reach any output.
**Suggested branch:** `feat/diagnostic-log` (the checkout is on `main`, and the untracked
`SPEC.2026-10-10-migrate-adaptive.md.bak` belongs to no commit of this work).

## Settled here (the SPEC's `## Not yet specified`)

1. **Redaction patterns** (ADR-0029 D3). Generated secrets are `randomBytes(32).toString("base64url")`,
   which is 43 characters of `[A-Za-z0-9_-]`. Token ids are 12 characters. Legacy secrets can be any
   string of 32 or more bytes. The rules run in this order:

   - known secrets, matched exactly and only when 32 bytes or longer;
   - `BEARER_PATTERN`;
   - `TOKEN_SHAPED_PATTERN`, a run of 43 or more base64url characters, which a token id never reaches;
   - absolute plugin, vault and home paths, replaced by `<plugin>`, `<vault>` and `<home>`, realpath
     spellings included.

   Every string is scrubbed before it is serialised and before it is truncated. Tool argument values
   are scrubbed at the one site that holds them, the dispatcher's `catch` (ADR-0029 D4).
2. **The logger moves into the plugin** (ADR-0029 D2). The only importer of `packages/shared`'s logger
   exports is `packages/obsidian-plugin/src/shared/logger.ts`, checked on 2026-10-11. The shim and
   the root `scripts/` import nothing from `shared`. The core goes to `src/shared/log/`, the facade
   keeps the `$/shared/logger` import path, and `packages/shared/src/logger.ts` is deleted.

## Invariants (hold at every task boundary)

1. **The logger never throws and never awaits on a caller's path.** `debug`, `info`, `warn` and
   `error` are synchronous enqueues. A request that logs must be byte-identical to one that does not
   (SPEC Constraint, ADR-0016).
2. **`recordEra` stays exactly where it is.** Request events are emitted after it and read only the
   request and `res.statusCode`.
3. **The facade imports nothing that imports the logger.** That rules out `SettingsStore`,
   `tokenStore` and `main`. Configuration, level and secrets are pushed in by the diagnostics feature.
4. **No tool argument value and no note content reaches a line.** Argument key names only.
5. **No `eslint-disable` on `obsidianmd/*`.** Node builtins go through locally declared signatures,
   as `packages/shared/src/logger.ts` does today.

## Tasks

### Task 1 — Logger core contract, stubs and unit tests, test seam 1 (R-01, R-02, R-03, R-04, R-05, R-06, R-11)
Owner: tester
Files: packages/obsidian-plugin/src/shared/log/logLine.ts, packages/obsidian-plugin/src/shared/log/redact.ts, packages/obsidian-plugin/src/shared/log/logSink.ts, packages/obsidian-plugin/src/shared/log/createLogger.ts, packages/obsidian-plugin/src/shared/log/memoryLogFs.ts, packages/obsidian-plugin/src/features/diagnostics/services/logLevelSetting.ts, packages/obsidian-plugin/src/features/diagnostics/services/logLocation.ts, packages/obsidian-plugin/src/shared/log/logLine.test.ts, packages/obsidian-plugin/src/shared/log/redact.test.ts, packages/obsidian-plugin/src/shared/log/logSink.test.ts, packages/obsidian-plugin/src/shared/log/createLogger.test.ts, packages/obsidian-plugin/src/features/diagnostics/services/logLevelSetting.test.ts, packages/obsidian-plugin/src/features/diagnostics/services/logLocation.test.ts
Tests: logLine.test.ts, redact.test.ts, logSink.test.ts, createLogger.test.ts, logLevelSetting.test.ts, logLocation.test.ts
Signatures:
- LOG_LEVELS — `export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const` (logLine.ts)
- LogLevel — `export type LogLevel = (typeof LOG_LEVELS)[number]`
- LogFields — `export type LogFields = Record<string, unknown>`
- LogEntry — `export type LogEntry = { timestamp: number; level: LogLevel; message: string; fields?: LogFields }`
- DEFAULT_LOG_LEVEL — `export const DEFAULT_LOG_LEVEL: LogLevel = "INFO"`
- MAX_LINE_BYTES — `export const MAX_LINE_BYTES = 65_536`
- MAX_STRING_CHARS — `export const MAX_STRING_CHARS = 8_192`
- parseLogLevel — `export function parseLogLevel(value: unknown): LogLevel`
- isLevelEnabled — `export function isLevelEnabled(level: LogLevel, minimum: LogLevel): boolean`
- formatLogLine — `export function formatLogLine(entry: LogEntry, scrub: (text: string) => string): string`
- UNSERIALIZABLE — `export const UNSERIALIZABLE = "[unserializable]"`
- REDACTED_SECRET — `export const REDACTED_SECRET = "[REDACTED:secret]"` (redact.ts)
- REDACTED_TOKEN — `export const REDACTED_TOKEN = "[REDACTED:token]"`
- REDACTED_ARG — `export const REDACTED_ARG = "[REDACTED:arg]"`
- BEARER_PATTERN — `export const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi`
- TOKEN_SHAPED_PATTERN — `export const TOKEN_SHAPED_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g`
- MIN_SECRET_BYTES — `export const MIN_SECRET_BYTES = 32`
- MIN_ARG_VALUE_CHARS — `export const MIN_ARG_VALUE_CHARS = 4`
- RedactionPaths — `export type RedactionPaths = { vault?: readonly string[]; pluginDir?: readonly string[]; home?: readonly string[] }`
- Redactor — `export interface Redactor { scrub(text: string): string; rememberSecrets(secrets: readonly string[]): void; setPaths(paths: RedactionPaths): void }`
- createRedactor — `export function createRedactor(): Redactor`
- scrubArgumentValues — `export function scrubArgumentValues(text: string, args: unknown): string`
- LogFs — `export interface LogFs { appendFile(path: string, data: string): Promise<void>; stat(path: string): Promise<{ size: number }>; rename(from: string, to: string): Promise<void>; unlink(path: string): Promise<void>; readFile(path: string): Promise<string>; join(...parts: string[]): string }` (logSink.ts)
- LOG_FILE_NAME — `export const LOG_FILE_NAME = "diagnostic.log"` (rotated: `diagnostic.1.log` … `diagnostic.4.log`)
- ROTATED_FILE_COUNT — `export const ROTATED_FILE_COUNT = 4`
- MAX_FILE_BYTES — `export const MAX_FILE_BYTES = 5 * 1024 * 1024`
- FAILURE_PAUSE_MS — `export const FAILURE_PAUSE_MS = 30_000`
- PENDING_ENTRY_LIMIT — `export const PENDING_ENTRY_LIMIT = 1_000`
- logFilePaths — `export function logFilePaths(dir: string, fs: Pick<LogFs, "join">): readonly string[]`
- LogSinkOptions — `export type LogSinkOptions = { dir: string; fs: LogFs; now: () => number; warn: (message: string) => void; onResume?: (droppedLines: number) => void; maxFileBytes?: number }`
- LogSink — `export interface LogSink { readonly path: string; write(line: string): void; flush(): Promise<void>; tail(lines: number): Promise<string>; clear(): Promise<void> }`
- createLogSink — `export function createLogSink(options: LogSinkOptions): LogSink`
- LoggerConfig — `export type LoggerConfig = { dir: string; level: LogLevel; fs: LogFs; paths?: RedactionPaths; now?: () => number; warn?: (message: string) => void }` (createLogger.ts)
- Logger — `export interface Logger { debug(message: string, fields?: LogFields): void; info(message: string, fields?: LogFields): void; warn(message: string, fields?: LogFields): void; error(message: string, fields?: LogFields): void; configure(config: LoggerConfig): void; setLevel(level: LogLevel): void; getLevel(): LogLevel; getLogPath(): string | null; tail(lines: number): Promise<string>; clear(): Promise<void>; flush(): Promise<void>; close(): Promise<void>; rememberSecrets(secrets: readonly string[]): void }`
- createLogger — `export function createLogger(): Logger`
- frozen messages — `"diagnostic log resumed"` (WARN, `{ droppedLines }`), `"diagnostic log cleared"` (INFO, written at any level), `"diagnostic log level changed"` (INFO, `{ from, to }`, written at any level); console warning prefix `"MCP Connector: the diagnostic log cannot be written"`
- createMemoryLogFs — `export function createMemoryLogFs(options?: { failWrites?: () => boolean }): LogFs & { files: Map<string, string>; touched: Set<string>; concurrentRenames: number }` (memoryLogFs.ts, test-only)
- DIAGNOSTICS_SLICE — `export const DIAGNOSTICS_SLICE = "diagnostics"` (slice shape `{ logLevel: LogLevel }`, logLevelSetting.ts)
- readLogLevel — `export async function readLogLevel(plugin: PluginDataLike | undefined): Promise<LogLevel>`
- writeLogLevel — `export async function writeLogLevel(plugin: PluginDataLike, level: LogLevel): Promise<LogLevel>`
- LogLocation — `export type LogLocation = { dir: string; paths: RedactionPaths }` (logLocation.ts)
- resolveLogLocation — `export async function resolveLogLocation(plugin: { app: App; manifest: PluginManifest }, deps?: { homedir: () => string; realpath: (path: string) => Promise<string>; platform: () => string }): Promise<LogLocation | null>`
Red: yes

Every non-test file above is a **stub**: the declared types and constants are real, and the function
bodies `throw new Error("not implemented")`. `src/shared/logger.ts` is **not** touched in this task.
The 27 files that import it keep the old facade until Task 2, so the existing suite stays green and
only the new tests are red. The memory file system also counts overlapping `rename` calls, so a
concurrent rotation is observable.

`logLine.test.ts` asserts:

- one JSON object per line, ending in `\n`, with keys `timestamp` (ISO from the injected number),
  `level`, `message` and `fields`;
- an `Error` anywhere in `fields` becomes `{name, message, stack}` on the same line;
- circular values, `bigint` and a throwing getter each become `UNSERIALIZABLE`, and the line is still
  written;
- scrub reaches the message, nested values, object keys, array elements and stacks;
- truncation runs after the scrub. A 43-character token placed across the `MAX_STRING_CHARS` boundary
  leaves no fragment;
- an oversized entry stays at or under `MAX_LINE_BYTES`, its `fields` replaced by
  `{truncated: true, originalBytes}`, and still parses;
- `parseLogLevel(undefined | "verbose" | 3)` returns `"INFO"`, and `isLevelEnabled` passes its full
  level matrix.

`redact.test.ts` asserts:

- a configured secret becomes `REDACTED_SECRET`. This includes a 40-character legacy secret with
  `+/=!` in it, which the patterns alone would miss;
- a secret under 32 bytes is never registered;
- `Authorization: Bearer abc.def~ghi=` becomes `Bearer [REDACTED:token]`;
- runs of 43 and of 60 base64url characters become `REDACTED_TOKEN`. A 42-character run, a 12-character
  token id and a UUID survive, which documents the boundary;
- vault, plugin and home paths become their placeholders, longest match first. Realpath spellings are
  matched, and so are Windows backslash and forward-slash spellings;
- `scrubArgumentValues` replaces string leaves of 4 characters or more in the message and the stack,
  including their `JSON.stringify` spelling and nested values. It collapses each line's ArkType
  "(was …)" suffix and leaves a 3-character value alone, which documents the bound.

`logSink.test.ts`, with the memory file system and an injected clock, asserts:

- every path touched lies under `dir`, and lines land in `<dir>/diagnostic.log` (R-01);
- rotation happens when the next line would pass the threshold. The real `MAX_FILE_BYTES` is used
  once, a small `maxFileBytes` everywhere else;
- at most 5 files exist and the oldest is dropped;
- a burst of 10,000 `write`s with no `await` between them loses no line, splits none and orders all
  of them, and `concurrentRenames` stays 0;
- failing writes over 100 events produce exactly one `warn` call. While the clock is frozen inside
  `FAILURE_PAUSE_MS`, no `appendFile` is attempted. After the pause, with a healthy file system,
  writes resume and `onResume` receives the dropped count. A later failure opens a new episode and a
  second warning;
- `tail(200)` reaches into `.1` when the current file is short, and includes writes still pending;
- `clear()` removes all five files, tolerates `ENOENT`, never overlaps a rotation, and is followed by
  a fresh file on the next write;
- `flush()` never rejects.

`createLogger.test.ts` asserts:

- an unconfigured logger touches no file system and holds at most `PENDING_ENTRY_LIMIT` entries;
- held entries are written at `configure()`, with path redaction applied;
- DEBUG is dropped at the default level, and `setLevel` takes effect on the next call;
- the "level changed" and "cleared" lines appear even at ERROR;
- the four methods never throw on hostile fields;
- `rememberSecrets` applies to later lines;
- `close()` drains, then detaches: later events touch nothing;
- `getLogPath()` is `null` until `configure()`;
- a failure warning goes to `config.warn`.

`logLevelSetting.test.ts` asserts:

- a missing slice, an invalid value and a non-object slice each read as INFO, and reading never calls
  `saveData`;
- `writeLogLevel` goes through `updateSlice`, leaves `mcpTransport` and `toolLoading` deep-equal to
  before, and makes no save when the value is unchanged.

`logLocation.test.ts`, with the `FileSystemAdapter` stub from `src/test-setup.ts`, asserts:

- `dir` is the base path joined with `manifest.dir`, and falls back to `<configDir>/plugins/<id>`;
- a non-`FileSystemAdapter` gives `null`;
- `paths` carries both the given and the realpath spelling of the vault, the plugin directory and
  the home directory.

### Task 2 — Implement the logger core and swap the facade; retire the shared logger (R-01, R-02, R-03, R-04, R-05, R-06, R-11, R-13)
Owner: coder
Files: packages/obsidian-plugin/src/shared/log/logLine.ts, packages/obsidian-plugin/src/shared/log/redact.ts, packages/obsidian-plugin/src/shared/log/logSink.ts, packages/obsidian-plugin/src/shared/log/createLogger.ts, packages/obsidian-plugin/src/shared/log/nodeLogFs.ts, packages/obsidian-plugin/src/shared/logger.ts, packages/obsidian-plugin/src/features/diagnostics/services/logLevelSetting.ts, packages/obsidian-plugin/src/features/diagnostics/services/logLocation.ts, packages/shared/src/logger.ts (delete), packages/shared/src/index.ts, packages/obsidian-plugin/scripts/bench.ts, .gitignore
Tests: logLine.test.ts, redact.test.ts, logSink.test.ts, createLogger.test.ts, logLevelSetting.test.ts, logLocation.test.ts, toolRegistry.test.ts, preWarm.test.ts, tokenStore.test.ts
Signatures:
- nodeLogFs — `export const nodeLogFs: LogFs` (`fs/promises` `appendFile`, `stat`, `rename`, `unlink`, `readFile(path, "utf8")` and `path.join`, each behind a locally declared signature)
- logger — `export const logger: Logger = createLogger()` (src/shared/logger.ts)
- re-exports — `export type { LogLevel, LogFields } from "./log/logLine"; export type { Logger, LoggerConfig } from "./log/createLogger"` (src/shared/logger.ts)
- relies on — every Task 1 signature
Red: no

Fill in the Task 1 stubs until all six Task 1 test files pass.

- **No timers anywhere.** Drain the queue through a promise chain or `queueMicrotask`, and implement
  the failure pause by comparing `now()` values.
- **Byte lengths** come from `TextEncoder` (DOM lib) or `Buffer.byteLength`.
- **The facade's default `warn`** is `(m) => console.warn(m)`. It is the single sanctioned `console`
  call in plugin `src/` (Task 3's guard whitelists `src/shared/logger.ts`).
- **`logLevelSetting.ts`** reads with `readSlice` (never `loadSlice`, which persists) and writes with
  `updateSlice`, returning `current` when the value is equal.
- **`logLocation.ts`** reaches `os.homedir`, `fs.promises.realpath` and `process.platform` through
  locally typed signatures, injectable as `deps`.

**Swapping the facade.** Rewrite `src/shared/logger.ts` to `export const logger = createLogger()` and
delete the `NODE_ENV` branch, `LOGGER_CONFIG` and the arktype morph. The method shape stays
`(message: string, fields?: LogFields) => void`, so all 82 call sites and the three tests that
`spyOn(logger, …)` compile and run unchanged. `logger` stays a plain object with own function
properties, so `spyOn` keeps working.

**Call sites of the removed contract** (grep run 2026-10-11, full repo):

- `createLogger`, `loggerConfigMorph` and `InputLoggerConfig` from `"shared"` are imported only by
  `packages/obsidian-plugin/src/shared/logger.ts`, rewritten here. `getLogFilePath`,
  `logLevelSchema`, `LogLevel` and `FullLoggerConfig` have no importer.
- Delete `packages/shared/src/logger.ts` and the `export * from "./logger"` line in
  `packages/shared/src/index.ts`. `arktype` stays, because `types/prompts.ts` uses it.
- `packages/obsidian-plugin/scripts/bench.ts:10` claims "NODE_ENV=production keeps `$/shared/logger`
  on `console`". Reword it: an unconfigured logger never touches the disk, so the flag is no longer
  needed for that.
- `.gitignore`: add `diagnostic.log` and `diagnostic.*.log`. In development `scripts/link.ts` makes
  the repo root the plugin directory, and the existing `_.log` line is a mangled pattern that ignores
  nothing.

Run the **full** suite afterwards, not only the new files: the facade is imported by 27 files across
every feature.

### Task 3 — Transport, lifecycle and call-site event contract tests, test seam 2 (R-05, R-07, R-08, R-09, R-10, R-13)
Owner: tester
Files: packages/obsidian-plugin/src/features/mcp-transport/services/requestLog.ts, packages/obsidian-plugin/src/features/mcp-transport/services/requestLog.test.ts, packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.test.ts, packages/obsidian-plugin/src/features/mcp-transport/services/modernEra.test.ts, packages/obsidian-plugin/src/features/mcp-transport/services/httpServer.test.ts, packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.test.ts, packages/obsidian-plugin/src/features/mcp-transport/services/tokenStore.test.ts, packages/obsidian-plugin/src/features/mcp-transport/services/setup.test.ts, packages/obsidian-plugin/src/features/mcp-transport/services/port.test.ts, packages/obsidian-plugin/src/features/mcp-client-config/services/discoveryBroker.test.ts, packages/obsidian-plugin/src/features/semantic-search/services/productionWiring.test.ts, packages/obsidian-plugin/src/features/mcp-tools/tools/searchAndReplace.test.ts, packages/obsidian-plugin/src/features/semantic-search/services/chunker.test.ts, packages/obsidian-plugin/scripts/consoleRouting.test.ts
Tests: requestLog.test.ts, mcpServer.test.ts, modernEra.test.ts, httpServer.test.ts, toolRegistry.test.ts, tokenStore.test.ts, setup.test.ts, port.test.ts, discoveryBroker.test.ts, productionWiring.test.ts, searchAndReplace.test.ts, chunker.test.ts, consoleRouting.test.ts
Signatures:
- RequestOutcome — `export type RequestOutcome = "ok" | "tool_error" | "inactive_tool" | "rejected"` (requestLog.ts)
- VersionRung — `export type VersionRung = "middleware" | "deferred" | "sdk"`
- RefusalReason — `export type RefusalReason = "method_path" | "origin" | "auth" | "too_large" | "other"`
- RequestDescription — `export type RequestDescription = { method: string; tool?: string; argKeys?: string[]; requestedVersion?: string }`
- describeRequest — `export function describeRequest(parsedBody: unknown, headers: RequestHeaders): RequestDescription`
- argumentKeys — `export function argumentKeys(args: unknown): string[]`
- toolCallOutcome — `export function toolCallOutcome(isInactive: boolean, result: { isError?: boolean } | undefined): RequestOutcome`
- requestLogLevel — `export function requestLogLevel(status: number): LogLevel`
- refusalReason — `export function refusalReason(status: number): RefusalReason`
- REQUEST_EVENT — `export const REQUEST_EVENT = "mcp request"`
- TOOL_CALL_EVENT — `export const TOOL_CALL_EVENT = "mcp tool call"`
- VERSION_REJECTED_EVENT — `export const VERSION_REJECTED_EVENT = "mcp protocol version rejected"`
- event fields (frozen names) — tool call: `method`, `tool`, `argKeys`, `outcome`, `durationMs`, `tokenId`, `era`; request: `method`, `era`, `requestedVersion`, `tokenId`, `status`, `durationMs`, `reason` (plus `tool`, `argKeys`, `outcome: "rejected"` for a refused `tools/call`); version rejection: `requested`, `rung`, `era`, `tokenId` (`era` and `tokenId` absent on rung `"middleware"`)
- lifecycle messages (frozen) — new: `"MCP Connector HTTP server stopped"` (INFO `{ port }`), `"MCP Connector HTTP server port busy"` (WARN `{ port, code }`), `"Broker route registered"` (INFO `{ brokerPort, transportPort }`), `"semantic-search: started"` (INFO `{ provider }`), `"MCP Tools Plugin loading"` (INFO `{ pluginVersion, platform }`), `"MCP Tools Plugin unloading"` (INFO); kept: `"MCP Connector HTTP server listening"`, `"MCP Connector failed to start HTTP server"`, `"Hosting the shared MCP broker"`, `"Broker connection recovery failed"`, `"Broker route failed to start"`, `"MCP Tools Plugin loaded"`
- relies on — `logger.configure`, `logger.close`, `createMemoryLogFs` and the `REDACTED_*` constants from Tasks 1–2
Red: yes

`requestLog.ts` is a stub: its types and constants are real, its functions throw. These tests capture
the lines **actually written**, after redaction. Each file's `beforeEach` runs
`await logger.close(); logger.configure({ dir: "/mem", level: "DEBUG", fs: createMemoryLogFs() })`
and its `afterEach` runs `await logger.close()`. Closing first keeps entries held from other test
files out of the memory file system.

`requestLog.test.ts` asserts:

- `tools/call` gives the tool name and its key names in order, never a value;
- `initialize` takes `requestedVersion` from `params.protocolVersion`;
- the header wins over `_meta[PROTOCOL_VERSION_META_KEY]`, which wins over `params.protocolVersion`,
  and each is truncated to 64 characters;
- a batch and an unparseable body each give a placeholder method;
- the full `toolCallOutcome` matrix holds, with `undefined` giving `"rejected"`;
- `requestLogLevel(399)` is `"DEBUG"` and `requestLogLevel(400)` is `"INFO"`;
- `refusalReason` maps 401→auth, 403→origin, 404/405→method_path and 413→too_large.

`mcpServer.test.ts`, on the existing HTTP harness, asserts:

- a legacy `tools/call` that succeeds writes exactly one INFO `TOOL_CALL_EVENT` line with every
  frozen field, `outcome: "ok"`, `era: "legacy"` and a numeric `durationMs`. No argument value
  appears anywhere in the file;
- an `isError` result gives `tool_error`, and an adaptive-inactive tool gives `inactive_tool`;
- a tool that throws writes `Error handling <tool>` at ERROR. Its stack is redacted and holds no
  argument value, and the response bytes equal those from an unconfigured logger (R-10);
- an ArkType validation failure (a string where a number is expected) logs `(was [REDACTED:arg])`, and
  the response is unchanged;
- `initialize` and `tools/list` write a DEBUG `REQUEST_EVENT` with `era` and `requestedVersion`, and
  nothing at INFO;
- a legacy request carrying an unsupported 2026-era header writes exactly one WARN
  `VERSION_REJECTED_EVENT` with `rung: "deferred"` and no `REQUEST_EVENT`;
- after the same request sequence, the era counter totals are equal with the logger at DEBUG and with
  it unconfigured (ADR-0016);
- the sequence `initialize`, `tools/list`, `tools/call` (ok), `tools/call` (throws), `prompts/list`
  gets byte-identical status, content type and body with the logger at DEBUG and unconfigured.

`modernEra.test.ts` asserts:

- a modern `tools/call` logs `era: "modern"`;
- `server/discover` writes a DEBUG `REQUEST_EVENT` with `era: "modern"`;
- the existing "unsupported 2026-era revision" case also writes a WARN with `rung: "sdk"` and the
  requested value, and its response is unchanged.

`httpServer.test.ts` asserts:

- a pre-2026 unsupported header writes a WARN with `rung: "middleware"`, the `requested` value and
  no `tokenId` key;
- a 401 writes one INFO `REQUEST_EVENT` `{status: 401, reason: "auth"}`. Nothing token-shaped appears
  even though the `Authorization` header carried a 43-character token;
- a 413 writes one INFO line with `reason: "too_large"`.

`toolRegistry.test.ts` extends the existing "tool-error log redaction" describe. The ERROR fields
are `tool`, `errorCode` and `error {name, message, stack}`: no `params`, no raw `error` object, no
spread `data`, and no argument value in the message or the stack.

`tokenStore.test.ts` asserts that after `readTokens`, `addToken` and `regenerateToken`, a logged
string holding each secret is written with `REDACTED_SECRET`. That includes a hand-set non-base64url
legacy secret of 32 or more bytes.

The lifecycle files cover R-09:

- `setup.test.ts`: start writes "listening" `{port}`, teardown writes "stopped" `{port}`, and a
  start failure keeps its ERROR.
- `port.test.ts`: an `EADDRINUSE` on the first port writes the WARN "port busy" line
  `{port, code: "EADDRINUSE"}`, and the bind then succeeds on the next port.
- `discoveryBroker.test.ts`: a successful registration writes "Broker route registered", and the
  line holds neither the route id nor the access token.
- `productionWiring.test.ts`: a successful wiring writes "semantic-search: started".

The privacy call sites cover R-05:

- `searchAndReplace.test.ts`: an invalid regex's WARN line holds neither the pattern, the flags nor
  the pattern text inside the `RegExp` error.
- `chunker.test.ts`: the oversized-fence DEBUG line holds `headingLength` and not the heading text.

`scripts/consoleRouting.test.ts` (R-13) reads `packages/obsidian-plugin/src/**/*.{ts,svelte}` and
finds no `console.` call outside `src/shared/logger.ts`. It excludes `*.test.ts` and `src/**/assets/**`
(the generated shim and MCP App sources). The file lives outside `src/` on purpose, like
`link.test.ts`.

All of the above stays red until Tasks 4 and 5.

### Task 4 — Emit request, era, version and tool-error events; feed known secrets (R-05, R-07, R-08, R-10)
Owner: coder
Files: packages/obsidian-plugin/src/features/mcp-transport/services/requestLog.ts, packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts, packages/obsidian-plugin/src/features/mcp-transport/services/httpServer.ts, packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts, packages/obsidian-plugin/src/features/mcp-transport/services/tokenStore.ts
Tests: requestLog.test.ts, mcpServer.test.ts, modernEra.test.ts, httpServer.test.ts, toolRegistry.test.ts, tokenStore.test.ts, eraCounters.test.ts, eraRouter.test.ts, conformanceHarness.test.ts
Signatures:
- buildMcpServer — `(tokenId: string, promptsListChanged?: boolean) => McpServer`, unchanged; era derived inside as `promptsListChanged ? "modern" : "legacy"` (ADR-0017 discriminant, ADR-0029 D5)
- handleRequest — `(req: IncomingMessage, res: ServerResponse, tokenId: string) => Promise<void>`, unchanged
- relies on — every Task 3 `requestLog.ts` signature, `scrubArgumentValues`, `logger.rememberSecrets`
Red: no

- **`requestLog.ts`.** Implement the bodies. `requestedVersion` reads `PROTOCOL_VERSION_META_KEY`
  from `@modelcontextprotocol/server` 2.3.0, whose export was verified on 2026-10-11.
- **`mcpServer.ts`, the `tools/call` handler.** Take a start time at entry. Emit `TOOL_CALL_EVENT` in a
  `finally`, with `toolCallOutcome(isInactive, result)`. A throw before dispatch is logged as
  `rejected` and rethrown untouched.
- **`mcpServer.ts`, `handleRequest`.** The 413 branch logs INFO and returns, as today. Everything else
  is logged **after** `recordEra(era, tokenId)` and `scheduleEraFlush`, which stay byte-for-byte where
  they are:

  - The deferred-rung branch logs one WARN `rung: "deferred"` before its existing `return`.
  - Wrap the modern and legacy branches in `try`/`finally`. The `finally` reads `res.statusCode` and
    logs either the `sdk` WARN or `REQUEST_EVENT` at `requestLogLevel(status)`. It is the `sdk` WARN
    when the era is modern, the status is 400 and `requestedVersion` is outside the SDK's
    `SUPPORTED_PROTOCOL_VERSIONS`.
  - Never write to `res`.
- **`httpServer.ts`.** In the protocol-version 400 branch, log one WARN `rung: "middleware"` with the
  header value. In the other `!check.ok` branch and the declared-length 413, log one INFO
  `REQUEST_EVENT` `{status, reason}`. Change nothing else.
- **`toolRegistry.ts`, the dispatcher's `catch`.** Log `{tool, errorCode, error: {name, message, stack}}`,
  with message and stack passed through `scrubArgumentValues(…, params.arguments)`. Drop
  `...formattedError` and the raw `error`. Build the returned `errorJson` from the unscrubbed
  `formattedError` exactly as today (R-10).
- **`tokenStore.ts`.** Call `logger.rememberSecrets(tokens.map((t) => t.token))` in `readTokens` and in
  `withTokens`.

**Call sites of the changed log contract** (grep run 2026-10-11):

- The only test asserting the old tool-error fields is `toolRegistry.test.ts:569-604`. It checks
  `meta.tool`, no `params` and no argument value, all of which still hold, and Task 3 extends it.
- `modernEra.test.ts:492` asserts the SDK's own error for an unsupported revision, and that answer
  must not change.

Before merging, run `bun run test:conformance` by hand from `packages/obsidian-plugin`. It is not
in the per-PR gate, and CLAUDE.md requires it for any transport change.

### Task 5 — Configure at load, lifecycle events, privacy call sites, console routing (R-01, R-05, R-09, R-13)
Owner: coder
Files: packages/obsidian-plugin/src/features/diagnostics/index.ts, packages/obsidian-plugin/src/main.ts, packages/obsidian-plugin/src/features/mcp-transport/services/setup.ts, packages/obsidian-plugin/src/features/mcp-transport/services/port.ts, packages/obsidian-plugin/src/features/mcp-client-config/services/discoveryBroker.ts, packages/obsidian-plugin/src/features/semantic-search/services/productionWiring.ts, packages/obsidian-plugin/src/features/mcp-tools/tools/searchAndReplace.ts, packages/obsidian-plugin/src/features/semantic-search/services/chunker.ts, packages/obsidian-plugin/src/features/mcp-client-config/components/CopyConfigMenu.svelte, packages/obsidian-plugin/src/features/adaptive-tool-loading/components/AdaptiveToolLoadingSettings.svelte, packages/obsidian-plugin/src/shared/index.ts
Tests: setup.test.ts, port.test.ts, discoveryBroker.test.ts, productionWiring.test.ts, searchAndReplace.test.ts, chunker.test.ts, consoleRouting.test.ts, logLocation.test.ts
Signatures:
- setup — `export async function setup(plugin: McpToolsPlugin): Promise<void>` (features/diagnostics/index.ts; never throws)
- relies on — `resolveLogLocation`, `readLogLevel`, `nodeLogFs`, `readTokens`, `logger.configure`, `logger.close`, the Task 3 frozen lifecycle messages
Red: no

**Diagnostics setup** runs `resolveLogLocation`, then `readTokens` (whose `rememberSecrets` seeds the
redactor; errors swallowed), then `readLogLevel`, then
`logger.configure({ dir, level, fs: nodeLogFs, paths })`.

**`main.ts`.**

- In `onload`, call `await setupDiagnostics(this)` immediately **after** `createBrokerHost`, which
  must stay before the first `await`, and before `setupCore`. Then log "MCP Tools Plugin loading"
  `{pluginVersion, platform}`.
- In `onunload`, log "MCP Tools Plugin unloading" first and run `await logger.close()` last.
  Obsidian never awaits `onunload`, so this does not block unload.

**Lifecycle events.**

- `setup.ts` `teardown`: log "stopped" `{port}` after `stopHttpServer`.
- `port.ts` `bindWithFallback`: log the WARN "port busy" `{port, code}` on each `EADDRINUSE`.
- `discoveryBroker.ts` `establishControl`: log "Broker route registered" `{brokerPort, transportPort}`
  at `setStatus({state: "connected"})`. Never log `routeId` or `accessToken`.
- `productionWiring.ts`: log "semantic-search: started" `{provider}` once wiring succeeds.

The indexer's start, finish and failure lines and the existing broker lines already exist and stay
as they are.

**Privacy call sites** (ADR-0029 D4). `searchAndReplace.ts:70` stops logging `pattern` and `flags`,
and logs `{error: scrubArgumentValues(compiled.message, {pattern})}`. `chunker.ts:291` logs
`headingLength: section.heading.length` instead of `heading`.

**Console routing.**

- `CopyConfigMenu.svelte:132` becomes `logger.error("[mcpb] generation failed", { error: err })`.
- `AdaptiveToolLoadingSettings.svelte:250` becomes `logger.warn(…)` with the same text and fields.
- `shared/index.ts:134` becomes `logger.error("Smart Connections search failed", { error })`.

Run `bun run check:svelte` for the two Svelte files.

R-09's "bridge" is read here as the plugin-side client bridging path: the shared discovery broker and
its route. The Windows Python bridge and the `.mcpb` shim run in separate processes and are out of
scope per the SPEC.

### Task 6 — Diagnostics settings section (R-03, R-12)
Owner: coder
Files: packages/obsidian-plugin/src/features/diagnostics/components/DiagnosticsSection.svelte, packages/obsidian-plugin/src/features/diagnostics/services/revealInFolder.ts, packages/obsidian-plugin/src/features/diagnostics/index.ts, packages/obsidian-plugin/src/features/core/components/SettingsTab.svelte
Tests: logLevelSetting.test.ts, createLogger.test.ts
Signatures:
- revealInFolder — `export function revealInFolder(path: string): boolean` (Electron `shell.showItemInFolder` via the host `require` binding, same indirection as `mcpbDownload.ts` `electronDialog`; tries `electron.shell`, then `electron.remote?.shell`; `false` when unavailable)
- FeatureSettings — `export { default as FeatureSettings } from "./components/DiagnosticsSection.svelte"` (features/diagnostics/index.ts)
- DiagnosticsSection props — `export let plugin: McpToolsPlugin`
- TAIL_LINES — `export const TAIL_LINES = 200`
- UI strings (frozen) — heading `"Diagnostics"`; level options `"DEBUG"`, `"INFO"`, `"WARN"`, `"ERROR"`; buttons `"Show in folder"`, `"Copy last 200 lines"`, `"Clear log"`; confirm `"Delete the diagnostic log and its rotated files? This cannot be undone."`; Notices `"Copied the last 200 log lines to the clipboard."` and `"Diagnostic log cleared."`
Red: no

The section mounts last in `SettingsTab.svelte`. The dropdown starts from `logger.getLevel()`. On
change it awaits `writeLogLevel(plugin, level)`, then calls `logger.setLevel(level)`. If the write
fails, a Notice appears and the dropdown reverts. The path field shows `logger.getLogPath()` read-only,
and reads "not available" when it is `null`. "Show in folder" falls back to a Notice naming the path
when `revealInFolder` returns `false`. "Copy" runs
`navigator.clipboard.writeText(await logger.tail(TAIL_LINES))`; the lines in the file are already
redacted. "Clear" uses `confirm()`, as `AccessControlSection.svelte` does, then `await logger.clear()`.

No automated test (SPEC test seam 3, R-12 `no-test`). Run `bun run check:svelte`, then a manual pass
in a real vault: build, quit Obsidian fully with Cmd+Q, reopen, and confirm `get_server_info` reports
the new version before asserting anything. Then check that:

- a level change applies without a reload and survives a restart;
- "Show in folder" reveals the file;
- the copied tail is redacted and holds no token from `data.json`;
- "Clear log" asks first, and the next event starts a fresh file whose first line is
  "diagnostic log cleared".

### Task 7 — Update tests and call-sites asserting the old behaviour; user-facing note and CHANGELOG (R-01, R-14)
Owner: coder
Files: README.md, .github/ISSUE_TEMPLATE/bug_report.md, CHANGELOG.md
Tests: consoleRouting.test.ts
Signatures:
- frozen strings — README subsection heading `"Diagnostic log"`; log path `<vault>/.obsidian/plugins/<plugin folder>/diagnostic.log` (default folder `mcp-tools-istefox`); bounds `"5 MB per file, 5 files, about 25 MB"`
Red: no

These are the remaining call sites of the old behaviour, from the full-repo grep run on 2026-10-11.

**`README.md:576`** says "General logs: Settings → **Open Logs**, or Obsidian's console". No
"Open Logs" button exists in the plugin, and the console is no longer written. Replace the sentence
with a pointer to a new "Diagnostic log" subsection under Troubleshooting. That subsection covers:

- where the file lives;
- the size bounds;
- what is never in it: tokens, tool argument values, note content, absolute paths;
- what can be: vault-relative note paths in some failure lines, so review a copied tail before
  posting it publicly;
- switching to DEBUG while reproducing a problem and back to INFO afterwards;
- how to attach the file to an issue, or use "Copy last 200 lines".

**`.github/ISSUE_TEMPLATE/bug_report.md:42-47`** tells users to click a nonexistent "Open Logs"
under Resources. Replace those steps with Settings → Diagnostics → "Copy last 200 lines", plus
attaching `diagnostic.log`.

**`CHANGELOG.md` `## [Unreleased]`** gets:

- `### Added`: the diagnostic log and the Diagnostics settings section;
- `### Changed`: the plugin no longer writes to the developer console. Development builds no longer
  write to the OS log directory.

The release cut's `checkChangelogReady` later moves these notes under their version heading.

**Left as is, on purpose:**

- `docs/audit-2026-10-02.md:172`, a historical record;
- the three tests that spy on the logger (`toolRegistry.test.ts`, `preWarm.test.ts`,
  `tokenStore.test.ts`), which stay green against the new facade with no change;
- `SPEC.md`'s "79 existing call sites" (82 counted on 2026-10-11), which is the approved requirement
  text.

Finish with the full gate from the repo root: `bun run check && bun test && bun run format:check`,
then `bun run check:svelte` and `bun run test:mcpb` from `packages/obsidian-plugin`. Run the full
suite, not only the touched modules. The facade and the transport are shared by every feature.

## Risks & HITL gates

- **HITL: commit and push.** Work on `feat/diagnostic-log`, never on `main`. Keep the untracked
  `SPEC.2026-10-10-migrate-adaptive.md.bak` out of every commit.
- **HITL: deletion.** Task 2 deletes the tracked `packages/shared/src/logger.ts`. Git can recover it,
  but it is still a file deletion that needs confirming.
- **HITL: settings shape.** A new `diagnostics` slice is added to `data.json`. The change is additive:
  older plugin versions ignore the key, and `updateSlice` preserves it. No existing slice is migrated.
- **Transport change.** Run `bun run test:conformance` by hand before merging. It is nightly only,
  and that run is the only conformance signal before merge.
- **Unresolved user decisions** (reported to the parent session, not decided here):

  1. Vault-relative note paths in existing failure lines (`find_broken_links`, `find_orphaned_notes`,
     the indexer). R-06 permits them, but the SPEC's tool-argument rationale calls note names user
     content. The plan keeps them and documents "review before posting".
  2. No console mirror (ADR-0029 D8, A5). Anyone used to reading DevTools loses plugin errors there.
  3. R-13 says existing call sites "run unchanged", but R-05 forces edits to
     `searchAndReplace.ts:70`, `chunker.ts:291` and the `toolRegistry.ts` catch. The plan reads R-13
     as API compatibility and lets R-05 win at those three sites.
  4. The meaning of "bridge" in R-09 (Task 5).
- **Over-redaction** of identifiers of 43 or more base64url characters is accepted (ADR-0029 A3).
  Argument values shorter than 4 characters may survive in handler-written error text.
- **401 storms.** A polling client with a bad token writes one INFO line per request. Rotation bounds
  the disk use but can push older history out.
- **Sync.** A vault on iCloud syncs the log. Two machines on one vault produce conflict copies. The
  SPEC accepts this.
- **Regex lookbehind.** `TOKEN_SHAPED_PATTERN` uses lookbehind, which is ES2018 and matches the
  tsconfig target. Support in Electron's V8 and in Bun's JavaScriptCore was not verified on this
  machine. Task 1's tests exercise it under Bun, and the manual pass under Electron.
- **Plugin reload overlap.** `close()` at unload detaches the old instance, so its late lines are
  dropped rather than written alongside the new instance.
- **No external resource** is needed: no API, OAuth, env var or port. The manual pass needs the Labs
  vault on iCloud, which is linked to the repo root, so the log appears there; Task 2 ignores it.
- **After `/ship`**, the chain's closing step should add a "Decisions from the diagnostic-log chain
  (ADR-0029)" section to `CLAUDE.md`, as the earlier chains did. This plan does not edit `CLAUDE.md`.

## Commands

TEST-CMD CANDIDATE: `bun test`
TEST-CMD MODE: brownfield

CHECK-CMD CANDIDATE: `bun run check && bun run format:check`

`bun run check:svelte` and `bun run test:mcpb` stay in the done gate (Task 7). `check:svelte` is
left out of the check command only because nobody has measured whether it fits the 30-second ceiling
alongside `tsc`.

## Build result (2026-10-12)

BUILD · DONE WITH WARNINGS
Files: 59 changed (new: src/shared/log/*, src/features/diagnostics/*, requestLog.ts, consoleRouting.test.ts, ADR-0029; deleted: packages/shared/src/logger.ts), nothing committed
Tests: 3086 pass, 0 fail across 184 files; check, format:check, check:svelte, test:mcpb green, 3 (coverage)
Review: sonnet, safe; opus, safe
Coverage: STALE-WAIVER R-12
Open: 1 (MAJOR SECURITY.md:181, accepted-open)
Deferred: 4 (needs-spec 2, accepted-open 1, out-of-diff 1)
Dropped: 7 (fix-hunk 2, post-sweep 2, nit 3)
Dispatch: Round 0 (red): tester — Task 1, tester — Task 3
Dispatch: Round 1: coder — MAJOR shared/index.ts:135, MINOR DiagnosticsSection.svelte:89, MINOR ADR-0029:176, MINOR logLevelSetting.ts:45, NIT redact.ts:94, NIT searchAndReplace.ts:70; debugger — MINOR mcpServer.test.ts:1140
Dispatch: Round 2: coder — MINOR toolRegistry.ts:1028, debugger — MINOR mcpServer.ts:678
Dispatch: Round 3 (sweep): coder — C1 packages/shared/src/logger.ts:1, toolRegistry.ts:1024, requestLog.ts:67, modernEra.test.ts:1448
Dispatch: Round 4 (sweep): coder — MINOR README.md:585, NIT mcpServer.ts:660
WARN: MAJOR left Open and recorded as DEFER accepted-open: SECURITY.md:181 still sends users to the developer console, which no longer receives log lines; fix the wording before /ship
WARN: STALE-WAIVER R-12, the SPEC's (no-test) clause is stale because a plan test file now mentions R-12; delete the clause from SPEC.md
INFO: review escalated, size: 58 changed files, threshold 20
INFO: AUTO nit DiagnosticsSection.svelte:99 was left out of the sweep set by mistake; the last sweep re-review found its pattern consistent with AdaptiveToolLoadingSettings.svelte:596

```text
DEFER	needs-spec	**MINOR** [other] packages/obsidian-plugin/src/features/mcp-transport/services/requestLog.ts:113 — Level depends on the HTTP status alone: a JSON-RPC error in a 200 response lands at DEBUG and leaves no line at the default INFO, while the comment and ADR-0029 D5 say every error is at INFO. Fix: align the claim, or decide the rule change (logRequest cannot read the body). (reviewer: opus)
DEFER	needs-spec	**MINOR** [other] packages/obsidian-plugin/src/features/mcp-transport/services/tokenStore.test.ts:869-885 — Seven test files still hand-roll the in-memory log-capture harness that logCapture.ts now owns (tokenStore 874, port 131, setup 175, chunker 403, searchAndReplace 178, productionWiring 292, discoveryBroker 1814); the sweep replaced only 3 of 10. Fix: replace each block with captureLogLines(), using lines(() => true) for the assert-absence cases. (reviewer: opus)
DEFER	accepted-open	**MAJOR** [other] SECURITY.md:181 — Best practice 6 still tells users to monitor the developer console for [mcp-transport]/[command-permissions] lines, but nothing reaches the console any more (consoleRouting guard; only logger.ts's failure warning remains). Fix: point it at Settings -> MCP Connector -> Diagnostics / diagnostic.log and drop the no-longer-existing [command-permissions] prefix. (reviewer: opus)
DEFER	out-of-diff	**MINOR** [other] docs/project-architecture.md:31 — The package tree still lists packages/shared/src/logger.ts as "Shared logger", but ADR-0029 D2 deletes that file in this change. Fix: remove the line or repoint it at packages/obsidian-plugin/src/shared/log/. (reviewer: sonnet)
DROP	fix-hunk	**MINOR** [other] packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.test.ts:1152 — The polling deadline (5000 ms) equals Bun's default per-test timeout, so a missing event kills the test by timeout instead of letting the assertion speak; same in modernEra.test.ts:1467 and httpServer.test.ts:468. Fix: lower the deadline to about 2000 ms or set an explicit higher per-test timeout. (reviewer: opus)
DROP	fix-hunk	**MINOR** [other] packages/obsidian-plugin/src/shared/index.ts:147 — in the new Smart Connections catch, `String(error)` can itself throw on a hostile thrown value, which would escape the catch and break the returns-[] contract. Low risk. (follow-up: coder)
DROP	post-sweep	**MINOR** [other] README.md:590 — "The plugin no longer writes to Obsidian's developer console" omits the one sanctioned console.warn per failure episode (src/shared/logger.ts + logSink.openEpisode), which the CHANGELOG does state, and the section never documents the log-cannot-be-written case. Fix: add the exception clause. (reviewer: sonnet, opus)
DROP	post-sweep	**NIT** packages/obsidian-plugin/src/features/diagnostics/components/DiagnosticsSection.svelte:99 — The only one-way select value= in the repo; the other selects use bind:value, which is also what forces the manual select.value revert. Fix: use bind:value and drop the manual assignment. (reviewer: opus)
FIX	swept	**MINOR** [plan-deviation] packages/shared/src/logger.ts:1 — Task 2 lists this file as deleted and the barrel's export * is gone, but the file remains on disk, unimported and still type-checked by bun run check. Fix: delete it after the plan's HITL deletion gate, or record why it was kept. (reviewer: sonnet, opus)
FIX	swept	**NIT** packages/obsidian-plugin/src/shared/log/redact.ts:94 — encoder.encode(secret).length runs before the secrets.has short-circuit, allocating per token on every per-request readTokens. Move the has check first. (reviewer: opus)
FIX	swept	**NIT** packages/obsidian-plugin/src/features/mcp-tools/tools/searchAndReplace.ts:70-71 — The comment claims neither pattern nor flags reaches the line, but flags is below MIN_ARG_VALUE_CHARS so it is never scrubbed, and a sub-4-character pattern survives too. Reword to the actual guarantee. (reviewer: opus)
FIX	swept	**MINOR** [plan-deviation] packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts:1024 — The isValidationFailure override makes the logged errorCode (invalid_params) diverge from the one sent to the client (internal_error) without keeping the latter, and neither plan Task 4 nor ADR-0029 D4 provides it. Fix: keep errorCode aligned with the response and add a separate field, or record the deviation in the ADR. (reviewer: opus)
FIX	swept	**NIT** packages/obsidian-plugin/src/features/mcp-transport/services/requestLog.ts:67 — Direct read of headers["mcp-protocol-version"] instead of getHeader() from middleware.ts, the feature's header accessor. (reviewer: opus)
FIX	swept	**NIT** packages/obsidian-plugin/src/features/mcp-transport/services/modernEra.test.ts:1448 — The lines() helper and its hooks are duplicated verbatim in three test files: extract into test-setup.ts. (reviewer: opus)
FIX	swept	**NIT** packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts:660 — The request-event level branches on requestLogLevel(status) === "INFO" and sends everything else to logger.debug, so a future WARN return would be filed at DEBUG. Fix: dispatch through the level or narrow the return type to "DEBUG" | "INFO". (reviewer: opus)
```
