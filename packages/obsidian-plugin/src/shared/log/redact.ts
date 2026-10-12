/**
 * Central redaction (ADR-0029 D3, D4).
 *
 * `scrub` runs on raw strings, never on serialised JSON, in a fixed order:
 * known secrets, the Authorization scheme, token-shaped runs, then absolute
 * paths. `scrubArgumentValues` is the one call-site scrub (D4): only the
 * tool dispatcher holds both the arguments and the error text.
 */

export const REDACTED_SECRET = "[REDACTED:secret]";
export const REDACTED_TOKEN = "[REDACTED:token]";
export const REDACTED_ARG = "[REDACTED:arg]";

export const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;

export const TOKEN_SHAPED_PATTERN =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g;

/** A secret shorter than this many UTF-8 bytes is never registered. */
export const MIN_SECRET_BYTES = 32;

/** A tool argument string shorter than this is never scrubbed from text. */
export const MIN_ARG_VALUE_CHARS = 4;

export type RedactionPaths = {
  vault?: readonly string[];
  pluginDir?: readonly string[];
  home?: readonly string[];
};

export interface Redactor {
  scrub(text: string): string;
  rememberSecrets(secrets: readonly string[]): void;
  setPaths(paths: RedactionPaths): void;
}

/** How deep `scrubArgumentValues` searches the arguments for string leaves. */
const MAX_ARG_DEPTH = 8;

/** ArkType's ` (was …)` suffix at the end of a summary line. */
const ARKTYPE_WAS_SUFFIX = / \(was .*\)$/gm;

const encoder = new TextEncoder();

function replaceAll(text: string, needle: string, replacement: string): string {
  return needle === "" ? text : text.split(needle).join(replacement);
}

/** Longest first, so a nested path wins over the one containing it. */
function byLengthDescending(a: string, b: string): number {
  return b.length - a.length;
}

/**
 * Every spelling a path can take in a message: as given, and on Windows
 * with either separator. A trailing separator is dropped so `<vault>/x`
 * keeps its own.
 */
function pathSpellings(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed === "") return [];
  return [
    ...new Set([
      trimmed,
      trimmed.replace(/\\/g, "/"),
      trimmed.replace(/\//g, "\\"),
    ]),
  ];
}

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  let orderedSecrets: string[] = [];
  let pathRules: { spelling: string; placeholder: string }[] = [];

  return {
    scrub(text) {
      let out = text;
      for (const secret of orderedSecrets) {
        out = replaceAll(out, secret, REDACTED_SECRET);
      }
      out = out.replace(BEARER_PATTERN, `$1 ${REDACTED_TOKEN}`);
      out = out.replace(TOKEN_SHAPED_PATTERN, REDACTED_TOKEN);
      for (const { spelling, placeholder } of pathRules) {
        out = replaceAll(out, spelling, placeholder);
      }
      return out;
    },

    rememberSecrets(list) {
      let grew = false;
      for (const secret of list) {
        if (typeof secret !== "string") continue;
        if (secrets.has(secret)) continue;
        if (encoder.encode(secret).length < MIN_SECRET_BYTES) continue;
        secrets.add(secret);
        grew = true;
      }
      if (grew) orderedSecrets = [...secrets].sort(byLengthDescending);
    },

    setPaths(paths) {
      const rules: { spelling: string; placeholder: string }[] = [];
      const add = (
        list: readonly string[] | undefined,
        placeholder: string,
      ) => {
        for (const path of list ?? []) {
          for (const spelling of pathSpellings(path)) {
            rules.push({ spelling, placeholder });
          }
        }
      };
      add(paths.pluginDir, "<plugin>");
      add(paths.vault, "<vault>");
      add(paths.home, "<home>");
      rules.sort((a, b) => byLengthDescending(a.spelling, b.spelling));
      pathRules = rules;
    },
  };
}

function collectStringLeaves(
  value: unknown,
  depth: number,
  out: Set<string>,
): void {
  if (typeof value === "string") {
    if (value.length >= MIN_ARG_VALUE_CHARS) out.add(value);
    return;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_ARG_DEPTH) {
    return;
  }
  const children: unknown[] = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const child of children) collectStringLeaves(child, depth + 1, out);
}

/**
 * Replaces every string leaf of `args` (4 characters or more, searched to a
 * bounded depth) found in `text`, raw and in its `JSON.stringify` spelling,
 * and collapses ArkType's ` (was …)` suffix on each line. Never throws: on
 * hostile arguments the text is still returned with whatever was replaced.
 */
export function scrubArgumentValues(text: string, args: unknown): string {
  let out = text;
  try {
    const leaves = new Set<string>();
    collectStringLeaves(args, 0, leaves);
    const needles = new Set<string>();
    for (const leaf of leaves) {
      const json = JSON.stringify(leaf);
      needles.add(json);
      needles.add(json.slice(1, -1));
      needles.add(leaf);
    }
    const ordered = [...needles]
      .filter((n) => n.length >= MIN_ARG_VALUE_CHARS)
      .sort(byLengthDescending);
    for (const needle of ordered) out = replaceAll(out, needle, REDACTED_ARG);
  } catch {
    // Hostile arguments: keep what was replaced so far.
  }
  return out.replace(ARKTYPE_WAS_SUFFIX, ` (was ${REDACTED_ARG})`);
}
