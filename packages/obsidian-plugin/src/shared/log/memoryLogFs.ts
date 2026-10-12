/**
 * In-memory `LogFs` for tests. Never imported by production code.
 *
 * Beyond storing files it records what a test needs to observe:
 *
 * - `touched`: every path any method was called with, so a test can assert
 *   that nothing outside the log directory was reached (R-01).
 * - `concurrentRenames`: how many `rename` calls started while another was
 *   still in flight. Rotation must be serialised, so a correct sink leaves
 *   this at 0. Each operation yields to the microtask queue before it acts,
 *   which is what makes an overlap observable at all.
 * - `failWrites`: while it returns true, `appendFile` and `rename` reject, the
 *   way an unwritable directory or a locked file does.
 *
 * Errors carry a Node-style `code` (`ENOENT`, `EACCES`) so the sink's
 * "tolerate ENOENT" paths run against something shaped like the real thing.
 */

import type { LogFs } from "./logSink";

type FsError = Error & { code: string };

function fsError(code: string, path: string): FsError {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

const encoder = new TextEncoder();

export function createMemoryLogFs(options?: {
  failWrites?: () => boolean;
}): LogFs & {
  files: Map<string, string>;
  touched: Set<string>;
  concurrentRenames: number;
} {
  const files = new Map<string, string>();
  const touched = new Set<string>();
  let renamesInFlight = 0;

  const fs: LogFs & {
    files: Map<string, string>;
    touched: Set<string>;
    concurrentRenames: number;
  } = {
    files,
    touched,
    concurrentRenames: 0,

    join: (...parts: string[]) => parts.join("/"),

    async appendFile(path, data) {
      touched.add(path);
      await Promise.resolve();
      if (options?.failWrites?.()) throw fsError("EACCES", path);
      files.set(path, (files.get(path) ?? "") + data);
    },

    async stat(path) {
      touched.add(path);
      await Promise.resolve();
      const content = files.get(path);
      if (content === undefined) throw fsError("ENOENT", path);
      return { size: encoder.encode(content).length };
    },

    async rename(from, to) {
      touched.add(from);
      touched.add(to);
      if (renamesInFlight > 0) fs.concurrentRenames += 1;
      renamesInFlight += 1;
      try {
        await Promise.resolve();
        if (options?.failWrites?.()) throw fsError("EACCES", from);
        const content = files.get(from);
        if (content === undefined) throw fsError("ENOENT", from);
        files.delete(from);
        files.set(to, content);
      } finally {
        renamesInFlight -= 1;
      }
    },

    async unlink(path) {
      touched.add(path);
      await Promise.resolve();
      if (!files.delete(path)) throw fsError("ENOENT", path);
    },

    async readFile(path) {
      touched.add(path);
      await Promise.resolve();
      const content = files.get(path);
      if (content === undefined) throw fsError("ENOENT", path);
      return content;
    },
  };

  return fs;
}
