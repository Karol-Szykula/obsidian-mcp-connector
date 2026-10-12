import { describe, expect, test } from "bun:test";
import {
  MIN_ARG_VALUE_CHARS,
  MIN_SECRET_BYTES,
  REDACTED_ARG,
  REDACTED_SECRET,
  REDACTED_TOKEN,
  createRedactor,
  scrubArgumentValues,
} from "./redact";

/** A run of `n` base64url characters, deterministic and mixed. */
function run(n: number): string {
  return "aB3_-xY9".repeat(Math.ceil(n / 8)).slice(0, n);
}

describe("redact constants", () => {
  test("the placeholders and bounds are the documented ones", () => {
    expect(REDACTED_SECRET).toBe("[REDACTED:secret]");
    expect(REDACTED_TOKEN).toBe("[REDACTED:token]");
    expect(REDACTED_ARG).toBe("[REDACTED:arg]");
    expect(MIN_SECRET_BYTES).toBe(32);
    expect(MIN_ARG_VALUE_CHARS).toBe(4);
  });
});

describe("createRedactor — known secrets (R-05)", () => {
  test("a configured base64url secret becomes REDACTED_SECRET, not REDACTED_TOKEN", () => {
    const secret = run(43);
    const r = createRedactor();
    r.rememberSecrets([secret]);
    expect(r.scrub(`token=${secret};`)).toBe(`token=${REDACTED_SECRET};`);
  });

  test("a 40-character legacy secret with +/=! in it is redacted, which the patterns alone would miss", () => {
    const secret = "ab+/=!cd".repeat(5);
    expect(secret).toHaveLength(40);
    const withoutIt = createRedactor();
    expect(withoutIt.scrub(`x ${secret} y`)).toContain(secret);

    const r = createRedactor();
    r.rememberSecrets([secret]);
    const out = r.scrub(`x ${secret} y and again ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toBe(`x ${REDACTED_SECRET} y and again ${REDACTED_SECRET}`);
  });

  test("a secret under 32 bytes is never registered", () => {
    const r = createRedactor();
    const thirtyOne = "s".repeat(31);
    r.rememberSecrets(["short-secret", thirtyOne]);
    expect(r.scrub(`a short-secret b ${thirtyOne} c`)).toBe(
      `a short-secret b ${thirtyOne} c`,
    );
  });

  test("a secret of exactly 32 bytes is registered", () => {
    const r = createRedactor();
    r.rememberSecrets(["t".repeat(32)]);
    expect(r.scrub(`Authorization: ${"t".repeat(32)}`)).toBe(
      `Authorization: ${REDACTED_SECRET}`,
    );
  });

  test("the floor is counted in UTF-8 bytes, not characters", () => {
    // 20 characters, 40 bytes.
    const secret = "é".repeat(20);
    const r = createRedactor();
    r.rememberSecrets([secret]);
    expect(r.scrub(`x ${secret} y`)).toBe(`x ${REDACTED_SECRET} y`);
  });

  test("the set only grows: an earlier secret survives a later call", () => {
    const first = "first-secret-".padEnd(40, "1");
    const second = "second-secret-".padEnd(40, "2");
    const r = createRedactor();
    r.rememberSecrets([first]);
    r.rememberSecrets([second]);
    expect(r.scrub(`${first} ${second}`)).toBe(
      `${REDACTED_SECRET} ${REDACTED_SECRET}`,
    );
  });
});

describe("createRedactor — Authorization scheme (R-05)", () => {
  test("a Bearer credential becomes `Bearer [REDACTED:token]`", () => {
    const r = createRedactor();
    expect(r.scrub("Authorization: Bearer abc.def~ghi=")).toBe(
      "Authorization: Bearer [REDACTED:token]",
    );
  });

  test("the scheme match is case-insensitive and keeps the spelling it found", () => {
    const r = createRedactor();
    expect(r.scrub("authorization: bearer abc123")).toBe(
      "authorization: bearer [REDACTED:token]",
    );
  });
});

describe("createRedactor — token-shaped runs (R-05)", () => {
  test("runs of 43 and of 60 base64url characters become REDACTED_TOKEN", () => {
    const r = createRedactor();
    expect(r.scrub(`id ${run(43)} end`)).toBe(`id ${REDACTED_TOKEN} end`);
    expect(r.scrub(`id ${run(60)} end`)).toBe(`id ${REDACTED_TOKEN} end`);
  });

  test("a 42-character run, a 12-character token id and a UUID survive", () => {
    const r = createRedactor();
    const id = run(12);
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(r.scrub(`a ${run(42)} b`)).toBe(`a ${run(42)} b`);
    expect(r.scrub(`tokenId=${id}`)).toBe(`tokenId=${id}`);
    expect(r.scrub(`route ${uuid}`)).toBe(`route ${uuid}`);
  });

  test("a token glued to its punctuation is still caught", () => {
    const r = createRedactor();
    expect(r.scrub(`{"t":"${run(43)}"}`)).toBe(`{"t":"${REDACTED_TOKEN}"}`);
  });
});

describe("createRedactor — absolute paths (R-06)", () => {
  const paths = {
    vault: ["/Users/me/Vault", "/Volumes/Data/Vault"],
    pluginDir: [
      "/Users/me/Vault/.obsidian/plugins/mcp-tools-istefox",
      "/Volumes/Data/Vault/.obsidian/plugins/mcp-tools-istefox",
    ],
    home: ["/Users/me", "/private/Users/me"],
  };

  test("vault, plugin and home paths become their placeholders, longest match first", () => {
    const r = createRedactor();
    r.setPaths(paths);
    expect(
      r.scrub(
        "log at /Users/me/Vault/.obsidian/plugins/mcp-tools-istefox/diagnostic.log",
      ),
    ).toBe("log at <plugin>/diagnostic.log");
    expect(r.scrub("note /Users/me/Vault/notes/a.md")).toBe(
      "note <vault>/notes/a.md",
    );
    expect(r.scrub("cache /Users/me/Library/Caches/x")).toBe(
      "cache <home>/Library/Caches/x",
    );
  });

  test("the realpath spelling is matched too", () => {
    const r = createRedactor();
    r.setPaths(paths);
    expect(r.scrub("note /Volumes/Data/Vault/notes/a.md")).toBe(
      "note <vault>/notes/a.md",
    );
    expect(
      r.scrub(
        "dir /Volumes/Data/Vault/.obsidian/plugins/mcp-tools-istefox/embeddings",
      ),
    ).toBe("dir <plugin>/embeddings");
    expect(r.scrub("home /private/Users/me/x")).toBe("home <home>/x");
  });

  test("Windows backslash and forward-slash spellings are both matched", () => {
    const r = createRedactor();
    r.setPaths({ vault: ["C:\\Users\\me\\Vault"] });
    const back = r.scrub("note C:\\Users\\me\\Vault\\notes\\a.md");
    expect(back).toContain("<vault>");
    expect(back).not.toContain("Users");
    const forward = r.scrub("note C:/Users/me/Vault/notes/a.md");
    expect(forward).toContain("<vault>");
    expect(forward).not.toContain("Users");
  });

  test("paths set later apply to later strings", () => {
    const r = createRedactor();
    expect(r.scrub("/Users/me/Vault/a.md")).toBe("/Users/me/Vault/a.md");
    r.setPaths({ vault: ["/Users/me/Vault"] });
    expect(r.scrub("/Users/me/Vault/a.md")).toBe("<vault>/a.md");
  });

  test("a known secret inside a path is scrubbed before the path rule runs", () => {
    const secret = run(43);
    const r = createRedactor();
    r.rememberSecrets([secret]);
    r.setPaths({ home: ["/Users/me"] });
    expect(r.scrub(`/Users/me/${secret}/x`)).toBe(
      `<home>/${REDACTED_SECRET}/x`,
    );
  });
});

describe("scrubArgumentValues (R-05, ADR-0029 D4)", () => {
  test("string leaves of 4 characters or more are replaced in the message, nested values included", () => {
    const args = {
      path: "private-note-body",
      options: { inner: "nested-secret-value", count: 12345 },
      list: ["listed-value", 7],
    };
    const text =
      "Failed on private-note-body, then nested-secret-value, then listed-value.";
    expect(scrubArgumentValues(text, args)).toBe(
      `Failed on ${REDACTED_ARG}, then ${REDACTED_ARG}, then ${REDACTED_ARG}.`,
    );
  });

  test("the same applies to a stack", () => {
    const stack =
      "Error: bad private-note-body\n    at handler (tool.ts:10:5)\n    at run private-note-body";
    const out = scrubArgumentValues(stack, { body: "private-note-body" });
    expect(out).not.toContain("private-note-body");
    expect(out).toContain("at handler (tool.ts:10:5)");
  });

  test("the JSON.stringify spelling of a value is replaced too", () => {
    const value = 'say "hello"\nthere';
    const text = `Unexpected token in {"body":${JSON.stringify(value)}}`;
    const out = scrubArgumentValues(text, { body: value });
    expect(out).not.toContain("hello");
    expect(out).not.toContain("there");
    expect(out).toContain(REDACTED_ARG);
  });

  test("ArkType's `(was …)` suffix is collapsed on each line", () => {
    const text =
      'limit must be a number (was "xx")\nname must be a string (was 12345)';
    const out = scrubArgumentValues(text, { limit: "xx", name: 12345 });
    expect(out).toBe(
      `limit must be a number (was ${REDACTED_ARG})\nname must be a string (was ${REDACTED_ARG})`,
    );
  });

  test("a 3-character value is left alone and a 4-character one is replaced, which documents the bound", () => {
    expect(scrubArgumentValues("value abc here", { k: "abc" })).toBe(
      "value abc here",
    );
    expect(scrubArgumentValues("value abcd here", { k: "abcd" })).toBe(
      `value ${REDACTED_ARG} here`,
    );
  });

  test("absent or non-object arguments leave the text alone", () => {
    expect(scrubArgumentValues("plain text", undefined)).toBe("plain text");
    expect(scrubArgumentValues("plain text", null)).toBe("plain text");
    expect(scrubArgumentValues("plain text", 42)).toBe("plain text");
  });
});
