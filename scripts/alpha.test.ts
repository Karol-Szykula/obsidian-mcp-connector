import { describe, expect, test } from "bun:test";
import { alphaVersion, compareStable, withVersion } from "./alpha";

describe("alphaVersion", () => {
  test("joins a higher base and the number", () => {
    expect(alphaVersion("3.1.0", "1", "3.0.3")).toEqual({
      ok: true,
      version: "3.1.0-alpha.1",
    });
    expect(alphaVersion("4.0.0", "12", "3.9.9")).toEqual({
      ok: true,
      version: "4.0.0-alpha.12",
    });
  });

  test("refuses a base that is not higher than the stable version", () => {
    for (const base of ["3.0.3", "3.0.2", "2.9.9"]) {
      const r = alphaVersion(base, "1", "3.0.3");
      expect(r.ok).toBe(false);
    }
  });

  test("refuses a malformed base", () => {
    for (const base of ["", "3.1", "v3.1.0", "3.1.0-beta.1", "3.1.0 "]) {
      expect(alphaVersion(base, "1", "3.0.3").ok).toBe(false);
    }
  });

  test("refuses a number that is not a positive integer", () => {
    for (const n of ["", "0", "01", "-1", "1.5", "a", "12345"]) {
      expect(alphaVersion("3.1.0", n, "3.0.3").ok).toBe(false);
    }
  });

  test("reports every problem at once", () => {
    const r = alphaVersion("3.0.0", "x", "3.0.3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toHaveLength(2);
  });
});

describe("compareStable", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareStable("3.1.0", "3.0.9")).toBeGreaterThan(0);
    expect(compareStable("3.0.3", "3.0.3")).toBe(0);
    expect(compareStable("2.10.0", "3.0.0")).toBeLessThan(0);
  });
});

describe("withVersion", () => {
  test("changes only the version and keeps the file shape", () => {
    const before = '{\n  "id": "x",\n  "version": "3.0.3",\n  "n": 1\n}\n';
    expect(withVersion(before, "3.1.0-alpha.1")).toBe(
      '{\n  "id": "x",\n  "version": "3.1.0-alpha.1",\n  "n": 1\n}\n',
    );
  });

  test("refuses a file with no version", () => {
    expect(() => withVersion('{"a":1}', "3.1.0-alpha.1")).toThrow();
  });
});
