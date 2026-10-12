/**
 * The production `LogFs`: Node's `fs/promises` and `path`.
 */

import {
  appendFile as _appendFile,
  readFile as _readFile,
  rename as _rename,
  stat as _stat,
  unlink as _unlink,
} from "fs/promises";
import { join as _join } from "path";
import type { LogFs } from "./logSink";

// Node builtins behind locally declared signatures: the community-plugin
// scanner type-checks without @types/node, so the bare imports resolve as
// `any` there and every call trips the no-unsafe-* rules. The assertions
// are exact subsets of the real @types/node signatures used here.
const appendFile = _appendFile as (path: string, data: string) => Promise<void>;
const stat = _stat as (path: string) => Promise<{ size: number }>;
const rename = _rename as (from: string, to: string) => Promise<void>;
const unlink = _unlink as (path: string) => Promise<void>;
const readFile = _readFile as (
  path: string,
  encoding: "utf8",
) => Promise<string>;
const join = _join as (...parts: string[]) => string;

export const nodeLogFs: LogFs = {
  appendFile: (path, data) => appendFile(path, data),
  stat: async (path) => ({ size: (await stat(path)).size }),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  readFile: (path) => readFile(path, "utf8"),
  join: (...parts) => join(...parts),
};
