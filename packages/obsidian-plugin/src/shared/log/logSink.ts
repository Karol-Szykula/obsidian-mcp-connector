/**
 * Serialised, rotating file sink (ADR-0029 D1, D6).
 *
 * Every write, rotation, tail and clear runs on one promise chain, so a
 * rotation never overlaps another and lines are never interleaved or split.
 * `write` is a synchronous enqueue: lines written back to back join one
 * batch, and a batch is appended in as few `appendFile` calls as the
 * rotation threshold allows.
 *
 * Nothing runs on a timer. A failed write opens a failure episode: the
 * batch is dropped, one warning is emitted, and every later batch is
 * dropped (and counted) until `now()` has moved `FAILURE_PAUSE_MS` past the
 * failure. The next batch after that is one attempt; its success closes the
 * episode and reports the dropped count through `onResume`.
 */

export interface LogFs {
  appendFile(path: string, data: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  join(...parts: string[]): string;
}

/** Rotated files are `diagnostic.1.log` … `diagnostic.4.log`. */
export const LOG_FILE_NAME = "diagnostic.log";

export const ROTATED_FILE_COUNT = 4;

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const FAILURE_PAUSE_MS = 30_000;

export const PENDING_ENTRY_LIMIT = 1_000;

const WARN_PREFIX = "MCP Connector: the diagnostic log cannot be written";

const encoder = new TextEncoder();

/** The current file first, then `.1` … `.4`. */
export function logFilePaths(
  dir: string,
  fs: Pick<LogFs, "join">,
): readonly string[] {
  const paths = [fs.join(dir, LOG_FILE_NAME)];
  for (let n = 1; n <= ROTATED_FILE_COUNT; n += 1) {
    paths.push(fs.join(dir, `diagnostic.${n}.log`));
  }
  return paths;
}

export type LogSinkOptions = {
  dir: string;
  fs: LogFs;
  now: () => number;
  warn: (message: string) => void;
  onResume?: (droppedLines: number) => void;
  maxFileBytes?: number;
};

export interface LogSink {
  readonly path: string;
  write(line: string): void;
  flush(): Promise<void>;
  tail(lines: number): Promise<string>;
  clear(): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describeFailure(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createLogSink(options: LogSinkOptions): LogSink {
  const { fs, now, warn, onResume } = options;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const files = logFilePaths(options.dir, fs);
  const current = files[0]!;

  /** The serialised queue. Never rejects. */
  let chain: Promise<void> = Promise.resolve();
  /** The batch new lines join, or null once its drain has started. */
  let openBatch: string[] | null = null;
  /** Bytes in the current file, or null when it must be re-read. */
  let size: number | null = null;
  /** Set while a failure episode is open. */
  let episode: { pausedUntil: number; dropped: number } | null = null;

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = chain.then(op);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function currentSize(): Promise<number> {
    try {
      return (await fs.stat(current)).size;
    } catch {
      return 0;
    }
  }

  /** Shift `.3`…`.1` up, the current file to `.1`. `.4` falls off. */
  async function rotate(): Promise<void> {
    for (let n = ROTATED_FILE_COUNT; n >= 1; n -= 1) {
      const from = files[n - 1]!;
      const to = files[n]!;
      try {
        await fs.rename(from, to);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    size = 0;
  }

  function openEpisode(error: unknown, dropped: number): void {
    episode = { pausedUntil: now() + FAILURE_PAUSE_MS, dropped };
    size = null;
    try {
      warn(
        `${WARN_PREFIX} (${describeFailure(error)}); logging pauses for ${FAILURE_PAUSE_MS / 1000} s.`,
      );
    } catch {
      // A broken warn must not break the queue.
    }
  }

  async function drain(batch: string[]): Promise<void> {
    if (openBatch === batch) openBatch = null;
    if (episode !== null) {
      if (now() < episode.pausedUntil) {
        episode.dropped += batch.length;
        return;
      }
    }

    let written = 0;
    try {
      if (size === null) size = await currentSize();
      let chunk = "";
      let chunkBytes = 0;
      let chunkLines = 0;
      for (const line of batch) {
        const bytes = encoder.encode(line).length;
        if (size + chunkBytes > 0 && size + chunkBytes + bytes > maxFileBytes) {
          if (chunk !== "") {
            await fs.appendFile(current, chunk);
            size += chunkBytes;
            written += chunkLines;
            chunk = "";
            chunkBytes = 0;
            chunkLines = 0;
          }
          // The in-memory size can be stale (the file was cleared or
          // replaced from outside): re-read it before rotating.
          size = await currentSize();
          if (size > 0 && size + bytes > maxFileBytes) await rotate();
        }
        chunk += line;
        chunkBytes += bytes;
        chunkLines += 1;
      }
      if (chunk !== "") {
        await fs.appendFile(current, chunk);
        size += chunkBytes;
        written += chunkLines;
      }
    } catch (error) {
      const lost = batch.length - written;
      if (episode !== null) {
        episode.pausedUntil = now() + FAILURE_PAUSE_MS;
        episode.dropped += lost;
        size = null;
      } else {
        openEpisode(error, lost);
      }
      return;
    }

    if (episode !== null) {
      const dropped = episode.dropped;
      episode = null;
      try {
        onResume?.(dropped);
      } catch {
        // A broken callback must not break the queue.
      }
    }
  }

  async function readLines(path: string): Promise<string[]> {
    try {
      return (await fs.readFile(path)).split("\n").filter((l) => l !== "");
    } catch {
      return [];
    }
  }

  return {
    path: current,

    write(line) {
      if (openBatch === null) {
        const batch: string[] = [];
        openBatch = batch;
        void enqueue(() => drain(batch));
      }
      openBatch.push(line);
    },

    flush() {
      return enqueue(async () => {}).catch(() => undefined);
    },

    tail(count) {
      openBatch = null;
      return enqueue(async () => {
        if (count <= 0) return "";
        let collected: string[] = [];
        for (const path of files) {
          const lines = await readLines(path);
          collected = [...lines, ...collected];
          if (collected.length >= count) break;
        }
        const last = collected.slice(-count);
        return last.length > 0 ? `${last.join("\n")}\n` : "";
      });
    },

    clear() {
      openBatch = null;
      return enqueue(async () => {
        let failure: unknown = null;
        for (const path of files) {
          try {
            await fs.unlink(path);
          } catch (error) {
            if (!isMissing(error) && failure === null) failure = error;
          }
        }
        size = null;
        if (failure !== null) throw failure;
        size = 0;
      });
    },
  };
}
