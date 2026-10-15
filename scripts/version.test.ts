/*
 * Unit tests for the pure parts of scripts/version.ts.
 *
 * The git and gh orchestration is NOT covered here and no attempt is made to
 * fake it: mocking `$` would test the mock. `DRY_RUN=1 bun run version <part>`
 * is what exercises that half, by printing every mutating command instead of
 * running it. This file covers the two functions where a wrong answer is
 * silent — a bump that lands on the wrong number, and a version check that
 * says a tree is fine when it is not.
 *
 * Importing this module at all depends on version.ts's `import.meta.main`
 * guard. Without it, this import would cut a release.
 */
import { describe, expect, test } from "bun:test";
import {
  blockingStatusPaths,
  bump,
  checkChangelogReady,
  envFlag,
  releaseBranchName,
  tagVerdict,
  verifyCommittedVersion,
} from "./version";

describe("bump", () => {
  test("major zeroes minor and patch", () => {
    expect(bump("2.0.1", "major")).toBe("3.0.0");
    expect(bump("1.4.9", "major")).toBe("2.0.0");
  });

  test("minor zeroes patch and keeps major", () => {
    // The case that regressed once: `bun run version minor` produced a patch
    // bump because the part was read from the wrong argv index.
    expect(bump("2.0.1", "minor")).toBe("2.1.0");
    expect(bump("0.27.13", "minor")).toBe("0.28.0");
  });

  test("patch increments only the patch", () => {
    expect(bump("2.0.0", "patch")).toBe("2.0.1");
    expect(bump("0.27.13", "patch")).toBe("0.27.14");
  });

  test("defaults to patch", () => {
    expect(bump("2.0.1")).toBe("2.0.2");
  });

  test("throws on an unknown part rather than guessing", () => {
    expect(() => bump("2.0.1", "mayor")).toThrow(/Invalid semver part: mayor/);
  });

  test("throws on a version that is not three numeric parts", () => {
    expect(() => bump("2.0", "patch")).toThrow(/three-part semver/);
    expect(() => bump("2.0.1-rc.1", "patch")).toThrow(/three-part semver/);
  });
});

describe("releaseBranchName", () => {
  test("is the name publish-side steps expect", () => {
    expect(releaseBranchName("2.0.2")).toBe("chore/release-2.0.2");
  });
});

describe("verifyCommittedVersion", () => {
  const files = (version: string, versionsKey = version) => ({
    pkg: JSON.stringify({ name: "x", version }),
    manifest: JSON.stringify({ id: "x", version, minAppVersion: "1.7.2" }),
    versions: JSON.stringify({ "1.0.1": "1.7.2", [versionsKey]: "1.7.2" }),
  });

  test("no problems when all three agree", () => {
    expect(verifyCommittedVersion(files("2.0.2"), "2.0.2")).toEqual([]);
  });

  test("names a stale package.json", () => {
    const f = files("2.0.2");
    f.pkg = JSON.stringify({ name: "x", version: "2.0.1" });
    const problems = verifyCommittedVersion(f, "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/package\.json at HEAD says "2\.0\.1"/);
  });

  test("names a stale manifest.json", () => {
    const f = files("2.0.2");
    f.manifest = JSON.stringify({ id: "x", version: "2.0.1" });
    const problems = verifyCommittedVersion(f, "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/manifest\.json at HEAD says "2\.0\.1"/);
  });

  test("names a versions.json missing the entry", () => {
    const problems = verifyCommittedVersion(files("2.0.2", "2.0.1"), "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /versions\.json at HEAD has no entry for 2\.0\.2/,
    );
  });

  test("reports every disagreement, not just the first", () => {
    const problems = verifyCommittedVersion(
      {
        pkg: JSON.stringify({ version: "2.0.1" }),
        manifest: JSON.stringify({ version: "1.9.9" }),
        versions: JSON.stringify({ "1.0.1": "1.7.2" }),
      },
      "2.0.2",
    );
    expect(problems).toHaveLength(3);
  });

  test("an unparseable file is a problem, never silently fine", () => {
    const f = files("2.0.2");
    f.manifest = "{ not json";
    const problems = verifyCommittedVersion(f, "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/manifest\.json at HEAD does not parse/);
  });

  test("an absent version field is a mismatch, not a pass", () => {
    const f = files("2.0.2");
    f.pkg = JSON.stringify({ name: "x" });
    expect(verifyCommittedVersion(f, "2.0.2")[0]).toMatch(/says undefined/);
  });
});

describe("checkChangelogReady", () => {
  const ready = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [2.1.1] — 2026-08-17",
    "",
    "### Fixed",
    "",
    "- Something.",
    "",
    "## [2.1.0] — 2026-08-17",
    "",
    "- Older.",
    "",
  ].join("\n");

  test("no problems when the notes have been moved", () => {
    expect(checkChangelogReady(ready, "2.1.1")).toEqual([]);
  });

  test("catches notes left under Unreleased, quoting the first line", () => {
    // The 2.1.0 near-miss exactly: the content was written, under the wrong
    // heading, and every other check in the repo stayed green.
    const stale = ready.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n### Fixed\n\n- Something.\n",
    );
    const problems = checkChangelogReady(stale, "2.1.1");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/still has content under/);
    expect(problems[0]).toMatch(/### Fixed/);
  });

  test("catches a missing heading for the version being cut", () => {
    const problems = checkChangelogReady(ready, "2.2.0");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no `## \[2\.2\.0\]` heading/);
  });

  test("a dated heading with nothing under it is not a pass", () => {
    const empty = ready.replace("\n### Fixed\n\n- Something.\n", "\n");
    const problems = checkChangelogReady(empty, "2.1.1");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/section is empty/);
  });

  test("a missing Unreleased heading is a problem, never silently fine", () => {
    // The check cannot do its job against a file it cannot read, and passing
    // there is the failure mode it exists to prevent.
    const problems = checkChangelogReady(
      "# Changelog\n\n## [2.1.1] — 2026-08-17\n\n- Something.\n",
      "2.1.1",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no `## \[Unreleased\]` heading/);
  });

  test("reports every problem, not just the first", () => {
    const problems = checkChangelogReady(
      "# Changelog\n\n## [Unreleased]\n\n- Left behind.\n",
      "2.1.1",
    );
    expect(problems).toHaveLength(2);
  });

  test("whitespace under Unreleased is empty, not content", () => {
    const padded = ready.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n  \n",
    );
    expect(checkChangelogReady(padded, "2.1.1")).toEqual([]);
  });

  test("the version label is matched exactly, not as a prefix", () => {
    // `2.1.1` must not be satisfied by a `## [2.1.10]` heading, which a naive
    // substring or unescaped-dot regex would accept.
    const other = ready.replace("## [2.1.1] —", "## [2.1.10] —");
    expect(checkChangelogReady(other, "2.1.1")[0]).toMatch(
      /no `## \[2\.1\.1\]` heading/,
    );
  });
});

describe("blockingStatusPaths", () => {
  test("empty status blocks nothing", () => {
    expect(blockingStatusPaths("", ["CHANGELOG.md"])).toEqual([]);
  });

  test("the allowed path does not block", () => {
    expect(blockingStatusPaths(" M CHANGELOG.md", ["CHANGELOG.md"])).toEqual(
      [],
    );
  });

  test("anything else blocks, and is named", () => {
    const blocking = blockingStatusPaths(
      " M CHANGELOG.md\n M src/main.ts\n?? notes.txt",
      ["CHANGELOG.md"],
    );
    expect(blocking).toEqual(["src/main.ts", "notes.txt"]);
  });

  test("with no allowance every dirty path blocks", () => {
    // Phase two's call, where a dirty tree means the tag would not describe
    // what was checked.
    expect(blockingStatusPaths(" M CHANGELOG.md")).toEqual(["CHANGELOG.md"]);
  });

  test("a rename is judged by its destination", () => {
    expect(
      blockingStatusPaths("R  old.md -> CHANGELOG.md", ["CHANGELOG.md"]),
    ).toEqual([]);
    expect(
      blockingStatusPaths("R  CHANGELOG.md -> notes.md", ["CHANGELOG.md"]),
    ).toEqual(["notes.md"]);
  });

  test("a quoted path is unquoted before comparison", () => {
    expect(blockingStatusPaths(' M "CHANGELOG.md"', ["CHANGELOG.md"])).toEqual(
      [],
    );
  });
});

describe("envFlag", () => {
  test("absent, empty, 0, false and no are off, in any case and padding", () => {
    for (const v of [undefined, "", "0", "false", "False", "NO", " false "]) {
      expect(envFlag(v)).toBe(false);
    }
  });

  test("any other value is on", () => {
    for (const v of ["1", "true", "TRUE", "yes", "anything"]) {
      expect(envFlag(v)).toBe(true);
    }
  });

  test("the string a workflow boolean renders to is off, which !! would get wrong", () => {
    // `dry_run: false` reaches `env:` as "false". `!!"false"` is true, and
    // that turned a real release into a silent dry run.
    const rendered = String(false);
    expect(!!rendered).toBe(true);
    expect(envFlag(rendered)).toBe(false);
  });
});

describe("tagVerdict", () => {
  const changelog = (version: string, left = "") =>
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      left,
      `## [${version}] — 2026-10-13`,
      "",
      "- Something.",
      "",
    ].join("\n");

  const tree = (version: string, tagExists: boolean, left = "") => ({
    pkg: JSON.stringify({ name: "x", version }),
    manifest: JSON.stringify({ id: "x", version, minAppVersion: "1.7.2" }),
    versions: JSON.stringify({ "1.0.1": "1.7.2", [version]: "1.7.2" }),
    changelog: changelog(version, left),
    tagExists,
  });

  test("a version that already has a tag is nothing, the ordinary push to main", () => {
    expect(tagVerdict(tree("3.0.2", true))).toEqual({
      kind: "nothing",
      version: "3.0.2",
    });
  });

  test("an untagged version whose files and changelog agree is ready", () => {
    expect(tagVerdict(tree("3.0.3", false))).toEqual({
      kind: "ready",
      version: "3.0.3",
    });
  });

  test("an untagged version with notes left under Unreleased is inconsistent, not nothing", () => {
    // The #476 shape one layer up: a release PR merges, then an ordinary PR
    // adds notes under Unreleased. Folding this into "nothing" would leave a
    // release that never happens and a run that stays green.
    const v = tagVerdict(tree("3.0.3", false, "\n- A later note.\n"));
    expect(v.kind).toBe("inconsistent");
    if (v.kind !== "inconsistent") return;
    expect(v.fileProblems).toEqual([]);
    expect(v.changelogProblems[0]).toMatch(/still has content under/);
  });

  test("an untagged version whose three files disagree is inconsistent", () => {
    const t = tree("3.0.3", false);
    t.manifest = JSON.stringify({ id: "x", version: "3.0.2" });
    const v = tagVerdict(t);
    expect(v.kind).toBe("inconsistent");
    if (v.kind !== "inconsistent") return;
    expect(v.version).toBe("3.0.3");
    expect(v.fileProblems[0]).toMatch(/manifest\.json at HEAD says "3\.0\.2"/);
  });

  test("an unparseable package.json is inconsistent with no version", () => {
    const t = tree("3.0.3", false);
    t.pkg = "{ not json";
    const v = tagVerdict(t);
    expect(v.kind).toBe("inconsistent");
    if (v.kind !== "inconsistent") return;
    expect(v.version).toBeNull();
    expect(v.fileProblems[0]).toMatch(/package\.json at HEAD does not parse/);
  });

  test("a package.json without a version is inconsistent, even when a tag lookup was made", () => {
    const t = tree("3.0.3", true);
    t.pkg = JSON.stringify({ name: "x" });
    const v = tagVerdict(t);
    expect(v.kind).toBe("inconsistent");
    if (v.kind !== "inconsistent") return;
    expect(v.version).toBeNull();
  });

  test("a tagged version is nothing even if its files have since drifted", () => {
    const t = tree("3.0.2", true);
    t.manifest = "{ not json";
    expect(tagVerdict(t).kind).toBe("nothing");
  });
});
