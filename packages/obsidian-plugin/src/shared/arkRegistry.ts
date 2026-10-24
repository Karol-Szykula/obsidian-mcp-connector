/**
 * The arktype registry this bundle put on the window, and its release.
 *
 * `@ark/schema` keeps every compiled validator's references (functions,
 * regexes, nodes) in a registry object that it assigns to `globalThis`
 * under `$ark`, or `$ark2`, `$ark3`, … when the name is taken, the first
 * time it is evaluated. Nothing removes it. Obsidian evaluates `main.js`
 * again on every enable, so each reload added one more registry, each
 * one kept that evaluation's module graph alive (about 40 MB on 3.1.0),
 * and the renderer eventually ran out of JavaScript heap (#597, #609,
 * ADR-0032).
 *
 * arktype does not export the name it picked, so the registry is found
 * by identity: the ambient scope's `ambient` getter returns the
 * `ambient` object of the registry the same `@ark/schema` copy created.
 * Another plugin's registry has a different one and is left alone.
 */
import { type } from "arktype";

const REGISTRY_NAME = /^\$ark\d*$/;

type GlobalRecord = Record<string, unknown>;

/** The `globalThis` key of this bundle's arktype registry, if it is there. */
export function findArkRegistryName(): string | null {
  const ambient: unknown = type.$.internal.ambient;
  if (ambient === null || typeof ambient !== "object") return null;
  const g = globalThis as GlobalRecord;
  for (const name of Object.getOwnPropertyNames(g)) {
    if (!REGISTRY_NAME.test(name)) continue;
    const candidate = g[name];
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as { ambient?: unknown }).ambient === ambient
    ) {
      return name;
    }
  }
  return null;
}

/**
 * Removes this bundle's arktype registry from `globalThis`. Returns the
 * name it had, or null when none was found (already released, or an
 * arktype build that no longer matches the lookup above).
 *
 * Must be the last thing the plugin instance does: a compiled validator
 * reaches the registry through its global name, so nothing of this
 * instance may run a schema afterwards. A later evaluation of the bundle
 * registers its own registry again, under the first free name.
 */
export function releaseArkRegistry(): string | null {
  const name = findArkRegistryName();
  if (name === null) return null;
  delete (globalThis as GlobalRecord)[name];
  return name;
}
