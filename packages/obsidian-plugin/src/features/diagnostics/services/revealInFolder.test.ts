import { describe, expect, test } from "bun:test";
import { revealInFolder } from "./revealInFolder";

/**
 * (coverage) Outside Electron there is no `electron` module: the contract in
 * the file header is that the caller gets `false` and falls back to naming
 * the path, never an exception.
 */
describe("revealInFolder (coverage)", () => {
  test("returns false, and does not throw, where Electron is unavailable", () => {
    expect(revealInFolder("/some/vault/diagnostic.log")).toBe(false);
  });
});
