/**
 * Pure rules and file rewrite for the alpha pre-release workflow (ADR-0030,
 * "Amendment: alpha pre-releases"). `release-alpha.yml` runs the git side;
 * this file decides which version is acceptable and rewrites the two files
 * that carry it. It never touches git.
 *
 *   ALPHA_BASE=3.1.0 ALPHA_NUMBER=1 bun scripts/alpha.ts --check
 *   ALPHA_BASE=3.1.0 ALPHA_NUMBER=1 bun scripts/alpha.ts
 *
 * `--check` validates and prints the tag. Without it the same checks run and
 * `package.json` and `manifest.json` in the working tree get the alpha
 * version. `versions.json` is left alone on purpose: Obsidian's store reads
 * it from main, and an alpha is not a version the store should know.
 */
import { appendFileSync, readFileSync, writeFileSync } from "fs";

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseStable(version: string): [number, number, number] | null {
  const m = STABLE.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Positive when `a` is a higher MAJOR.MINOR.PATCH than `b`. */
export function compareStable(a: string, b: string): number {
  const pa = parseStable(a);
  const pb = parseStable(b);
  if (!pa || !pb)
    throw new Error(`Not a MAJOR.MINOR.PATCH version: ${a} / ${b}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * The alpha version for `base` and `number`, or a list of reasons it is not
 * acceptable. The base must be higher than the stable version on main: under
 * SemVer `3.0.3-alpha.1` sorts BEFORE `3.0.3`, so a client that compares
 * versions would treat it as older than the release a user already has.
 */
export function alphaVersion(
  base: string,
  number: string,
  stable: string,
): { ok: true; version: string } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!parseStable(base)) {
    problems.push(
      `base version ${JSON.stringify(base)} is not MAJOR.MINOR.PATCH`,
    );
  } else if (parseStable(stable) && compareStable(base, stable) <= 0) {
    problems.push(
      `base version ${base} is not higher than the stable version ${stable}; ` +
        `${base}-alpha.N would sort before it`,
    );
  }
  if (!/^[1-9]\d{0,3}$/.test(number)) {
    problems.push(
      `alpha number ${JSON.stringify(number)} is not a positive integer`,
    );
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, version: `${base}-alpha.${number}` };
}

/** `text` (a JSON file) with its top-level `version` replaced, formatted as version.ts writes it. */
export function withVersion(text: string, version: string): string {
  const json = JSON.parse(text);
  if (typeof json.version !== "string") {
    throw new Error("file has no version string");
  }
  json.version = version;
  return JSON.stringify(json, null, 2) + "\n";
}

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function main(): void {
  const manifest = JSON.parse(readFileSync("./manifest.json", "utf8"));
  const result = alphaVersion(
    process.env.ALPHA_BASE ?? "",
    process.env.ALPHA_NUMBER ?? "",
    manifest.version,
  );
  if (!result.ok) die(result.problems.join("\n  "));
  const { version } = result;

  if (Bun.argv[2] !== "--check") {
    for (const path of ["./package.json", "./manifest.json"]) {
      writeFileSync(path, withVersion(readFileSync(path, "utf8"), version));
    }
    console.log(`Wrote ${version} to package.json and manifest.json.`);
  }
  console.log(version);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  }
}

if (import.meta.main) main();
