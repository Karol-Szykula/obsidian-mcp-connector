import { describe, expect, test } from "bun:test";
import { ALWAYS_ACTIVE_TOOLS, CORE_SET } from "../constants";
import type { TokenPolicy } from "../tokenPolicyStore";
import {
  migrationNoticeEntries,
  type MigrationNoticeInput,
} from "./migrationNotice";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS;
const SERVED = [
  ...new Set([
    ...CORE_SET,
    ...ALWAYS_ACTIVE_TOOLS,
    "called_tool",
    "unused_tool",
  ]),
];

const ALL: TokenPolicy = { profile: "all", promoted: [], allowed: null };

function input(
  overrides: Partial<MigrationNoticeInput> = {},
): MigrationNoticeInput {
  return {
    now: NOW,
    everCalledSince: NOW - 30 * DAY_MS,
    servedNames: SERVED,
    tokens: [
      { id: "t1", label: "Claude Desktop", createdAt: NOW - 60 * DAY_MS },
    ],
    policies: { t1: ALL },
    everCalled: { t1: ["called_tool"] },
    dismissed: [],
    ...overrides,
  };
}

describe("migrationNoticeEntries", () => {
  test("offers an eligible all token with its preview", () => {
    const [entry, ...rest] = migrationNoticeEntries(input());
    expect(rest).toHaveLength(0);
    expect(entry.tokenId).toBe("t1");
    expect(entry.label).toBe("Claude Desktop");
    expect(entry.deactivated).toEqual(["unused_tool"]);
    expect(entry.activeNow).toBe(SERVED.length);
    expect(entry.activeAfter).toBe(SERVED.length - 1);
  });

  test("never lists a tool the token has called", () => {
    const [entry] = migrationNoticeEntries(input());
    expect(entry.deactivated).not.toContain("called_tool");
  });

  test("skips a token that is not on all", () => {
    for (const profile of ["core", "adaptive"] as const) {
      const policies = { t1: { ...ALL, profile } };
      expect(migrationNoticeEntries(input({ policies }))).toEqual([]);
    }
  });

  test("skips a token still under observation", () => {
    const tokens = [{ id: "t1", label: "New", createdAt: NOW - 3 * DAY_MS }];
    expect(migrationNoticeEntries(input({ tokens }))).toEqual([]);
  });

  test("skips a dismissed token", () => {
    expect(migrationNoticeEntries(input({ dismissed: ["t1"] }))).toEqual([]);
  });

  test("skips a token whose migration would deactivate nothing", () => {
    const everCalled = { t1: ["called_tool", "unused_tool"] };
    expect(migrationNoticeEntries(input({ everCalled }))).toEqual([]);
  });

  test("offers nothing before the anchor exists or without served names", () => {
    expect(migrationNoticeEntries(input({ everCalledSince: 0 }))).toEqual([]);
    expect(migrationNoticeEntries(input({ servedNames: [] }))).toEqual([]);
  });

  test("skips a token with no policy read", () => {
    expect(migrationNoticeEntries(input({ policies: {} }))).toEqual([]);
  });

  test("keeps token order and evaluates each token on its own", () => {
    const entries = migrationNoticeEntries(
      input({
        tokens: [
          { id: "t1", label: "A", createdAt: NOW - 60 * DAY_MS },
          { id: "t2", label: "B", createdAt: NOW - 1 * DAY_MS },
          { id: "t3", label: "C", createdAt: NOW - 60 * DAY_MS },
        ],
        policies: { t1: ALL, t2: ALL, t3: ALL },
        everCalled: { t1: ["called_tool"] },
      }),
    );
    expect(entries.map((e) => e.tokenId)).toEqual(["t1", "t3"]);
    expect(entries[1].deactivated).toEqual(["called_tool", "unused_tool"]);
  });
});
