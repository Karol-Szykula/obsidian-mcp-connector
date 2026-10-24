import { afterEach, describe, expect, test } from "bun:test";
import { type } from "arktype";
import { findArkRegistryName, releaseArkRegistry } from "./arkRegistry";

type GlobalRecord = Record<string, unknown>;
const g = globalThis as GlobalRecord;

// Every test file in this process shares the arktype module and its
// compiled validators reach the registry by its global name, so each
// test puts the registry back under the name it had.
let released: { name: string; registry: unknown } | null = null;

afterEach(() => {
  if (released) {
    g[released.name] = released.registry;
    released = null;
  }
  delete g.$ark99;
});

function release(): string | null {
  const name = findArkRegistryName();
  const registry = name === null ? undefined : g[name];
  const result = releaseArkRegistry();
  if (result !== null) released = { name: result, registry };
  return result;
}

describe("arkRegistry", () => {
  test("finds the registry arktype registered on globalThis", () => {
    const name = findArkRegistryName();
    expect(name).toMatch(/^\$ark\d*$/);
    const registry = g[name!] as { ambient?: unknown; version?: unknown };
    expect(typeof registry.version).toBe("string");
    expect(registry.ambient).toBe(type.$.internal.ambient);
  });

  test("release removes that registry and leaves another plugin's alone", () => {
    // Another bundle's registry: same naming scheme, a different object.
    g.$ark99 = { ambient: {}, version: "0.0.0" };

    const name = release();
    expect(name).toMatch(/^\$ark\d*$/);
    expect(name).not.toBe("$ark99");
    expect(name! in g).toBe(false);
    expect(g.$ark99).toBeDefined();
  });

  test("a second release finds nothing", () => {
    expect(release()).not.toBeNull();
    expect(findArkRegistryName()).toBeNull();
    expect(releaseArkRegistry()).toBeNull();
  });

  test("a validator keeps working once the registry is back", () => {
    const name = release();
    expect(name).not.toBeNull();
    g[name!] = released!.registry;
    released = null;
    const schema = type({ port: "number" });
    expect(schema({ port: 27123 })).toEqual({ port: 27123 });
  });
});
