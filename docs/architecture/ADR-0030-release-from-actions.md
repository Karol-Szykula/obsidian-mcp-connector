# ADR-0030: Cut a release from GitHub Actions, with an approval gate

**Status:** Accepted (proven on the 3.0.3 cut, 2026-10-15)
**Date:** 2026-10-13
**Relates to:** `scripts/version.ts` (the two-phase release script, PR #464 and #479), `.github/workflows/release.yml` (build, attest, publish on a version tag)
**Supersedes:** nothing

---

## Context

A release is cut from a maintainer's terminal in two commands: `bun run version <part>`
(bump, branch, commit, push the branch, open the PR) and, after the PR merges,
`bun run version:tag` (tag `main`, push the tag). `release.yml` already builds, attests and
publishes off the tag. Both commands are blocked by Claude Code's auto-mode classifier, so a
session cannot run them and the maintainer types them by hand.

The goal is to cut a release from the Actions tab, from any device, without losing the human
gate before the point of no return. The gate stops being "a person types the second command"
and becomes "a person approves a deployment environment".

`scripts/version.ts` stays the single source of truth for the release rules. The workflows run
it. They re-implement none of its checks.

### Facts this ADR rests on (checked on 2026-10-13 with `gh api` against `istefox/obsidian-mcp-connector`)

1. The repository is public and owned by a user account, so environments with required
   reviewers and deployment-branch policies are available. It has no environments yet.
2. Classic branch protection on `main` requires `check-and-test` and `bridge-tests`
   (`strict: true`, `enforce_admins: true`, zero required approvals). `required_signatures` is off.
3. Three rulesets exist, none with a bypass actor. `General` (default branch: `deletion`,
   `non_fast_forward`), `main-strict` (default branch: `pull_request`, with all three merge
   methods allowed and `require_extra_approval_for_unattributed_changes: true`) and
   `tags-protections` (`refs/tags/0.*` only: `deletion`, `non_fast_forward`, `update`). The tag
   ruleset does not match any current version, which is 3.x, and has no `creation` rule.
4. `release.yml` triggers on `push` to any tag and to `main`, and its job runs only for a tag. Its
   first step refuses a tag that is not `MAJOR.MINOR.PATCH[-pre]`. Release immutability is on, so a
   published version number cannot be reused.
5. An event made with the default `GITHUB_TOKEN` does not start a new workflow run, except
   `workflow_dispatch` and `repository_dispatch`. A GitHub App installation token does.
6. `ci.yml` runs on `push` to `main` and on `pull_request` to `main`, with `cancel-in-progress`
   per ref.
7. `scripts/version.ts` imports only `bun` and `fs`, never prompts, and reads `DRY_RUN` and
   `FORCE` from the environment.

---

## Decision

### D1: A GitHub App token does every write, not `GITHUB_TOKEN`

Two independent reasons, each enough on its own:

- **Phase two:** the tag push must start `release.yml`. With `GITHUB_TOKEN` it would not.
- **Phase one:** the release PR must get `check-and-test` and `bridge-tests`. With `GITHUB_TOKEN`
  its `pull_request` runs would not start (or would wait for a manual approval), the two required
  checks would never report, and with `enforce_admins: true` not even the owner could merge it.

The App has Contents and Pull requests write, Metadata read, and nothing else. It has no
Workflows permission: the release commit touches only `package.json`, `manifest.json`,
`versions.json` and `CHANGELOG.md`, and a compromised prepare run must not be able to rewrite
`.github/workflows/**`. It is installed on this repository only and is not a bypass actor in any
ruleset: it pushes a branch and opens a pull request, it never pushes `main`.

The token is minted inside the job that uses it. It is never passed between jobs as an output,
because a job output is not masked in the job that reads it.

### D2: The human gate moves to an environment approval

`release-prepare.yml` (workflow_dispatch) runs phase one and publishes nothing. `release-tag.yml`
runs phase two. Its `tag` job targets the `release` environment, whose required reviewer is the
maintainer, so the point of no return waits for one deliberate approval, from the web or a phone.

"Prevent self-review" stays off on `release`: the reviewer is also the person who merged the
release PR, and turning it on would deadlock every release.

Both environments restrict deployment branches to `main`. `release-prepare` has no reviewers; the
branch policy is its whole purpose. Without it, `workflow_dispatch` runs the dispatched ref's own
copy of the workflow, so anyone able to push a branch could dispatch a modified file and print the
App token. Both workflows also fail in plain text when the ref is not `main`.

### D3: Phase two is a push trigger plus a detect job

`release-tag.yml` runs on every push to `main`. A first job, with no environment, runs
`bun run version:check`. In almost every run the answer is `nothing` and the run ends without
asking anything. Only `ready` reaches the environment, so an ordinary merge never produces an
approval request.

`workflow_run` on CI was rejected: CI cancels in-progress runs per ref, so a documentation commit
landing right after the release merge would cancel the release commit's CI, the conclusion would
be `cancelled`, and the tag would never happen with nothing red anywhere.
`pull_request: closed` was rejected as the gate: `head_ref` is a clean intent signal, but
`merge_commit_sha` is a point-in-time value, there is no manual recovery, and the tree checks are
needed anyway. A manual `workflow_dispatch` on the same workflow is the recovery path, and goes
through the same approval.

### D4: The verdict has three values, and `inconsistent` fails red

`tagVerdict` in `scripts/version.ts` is a pure function over the committed texts:

- `nothing`: the version at HEAD already has a tag. This is every ordinary push.
- `ready`: an untagged version whose `package.json`, `manifest.json` and `versions.json` agree
  and whose changelog section is filled in.
- `inconsistent`: an untagged version whose files disagree, or whose changelog is not ready.

`--check` exits 1 only for `inconsistent`. A boolean "should tag" would fold it into "no", and
the failure would be silent in exactly the way #476 exists to prevent: a release PR merges, an
ordinary PR then adds notes under `## [Unreleased]`, and nothing happens and nobody is told.
`tagAndPublish` consumes the same verdict, so detection and tagging cannot drift apart.

`--check` deliberately skips `assertReleasableMain`. Branch, clean tree and `origin/main` are
preconditions for tagging, and the tag phase runs them itself.

### D5: The tag job checks out the event commit, not `main`

The `tag` job passes no `ref:` to `actions/checkout`. On a push, the checkout is then the commit
that triggered the run, and `assertReleasableMain` fetches `origin/main` and refuses if `main`
moved while the job waited for approval. That refusal is the staleness guard. With `ref: main`
the job would silently tag whatever `main` had grown into, and a commit that was never in the
release PR would ship. When it refuses, the recovery is to re-run at the new head, not to force.

### D6: Re-running a successful tag job is red on purpose

Re-running the `tag` job asks for approval again and then fails at the script's
`Tag X already exists on origin` check. That red run is the real idempotence guard. Nothing in the
workflow YAML is needed to make it safe, and nothing should be added to turn it green.

### D7: `DRY_RUN` and `FORCE` are read with `envFlag`

`!!process.env.X` is true for any non-empty string, `"false"` included. A workflow boolean rendered
into `env:` arrives as that string, so every real release dispatched with `dry_run: false` would
have run as a dry run, printed `would run: ...` and exited 0 with nothing published. `envFlag`
treats absent, empty, `0`, `false` and `no` as off. The workflow also passes an empty string when
the box is not ticked. Neither workflow ever sets `FORCE`.

### D8: Pins

Both workflows pin bun to `1.4.2`, as `release.yml` does, and do not copy `ci.yml`'s `latest`: a
release command must not change behaviour between two runs with no commit in between. Neither runs
`bun install`: the script has no dependencies, and an install could migrate `bun.lock` in place and
trip the script's own clean-tree refusal. The commit identity is the App's bot with the noreply
address built from the bot's user id (not the App id): `main-strict` requires an extra approving
review for a commit whose email does not resolve to a GitHub account, and the resulting error does
not mention the identity.

---

## Alternatives considered

### A1: `GITHUB_TOKEN` for phase one, an App only for the tag (rejected)

It looks sufficient because phase one pushes a branch and opens a PR. It is not: the release PR
would never get its two required checks (see D1).

### A2: A personal access token (rejected)

It is tied to a person, has broader scope than one repository's contents and pull requests, and
expires silently. An App installed on one repository has narrower, auditable permissions.

### A3: Let `prepare` write the changelog heading (rejected for now)

The release notes' heading is renamed by a human in an ordinary PR before the cut, and the
workflow only verifies it. Letting `prepare` move the human-written body under the new heading
would be a pure string transform and would restore a one-PR flow, but it contradicts a documented
decision (the script refuses rather than writing the heading, #476). See the open question.

### A4: Fold detection into `DRY_RUN=1 bun run version:tag` (rejected)

On an ordinary push the version at HEAD is already released, so it would die at the tag-exists
check and turn most pushes to `main` red, and every refusal shares exit code 1. A verdict needs to
be a value, not an exit code to string-match.

---

## Consequences

### Positive

- A release is cut from the Actions tab, including from a phone, with one approval before the
  tag.
- The rules stay in one place. The workflows add no check of their own.
- A half-made release is a red run, not a silence.

### Negative

- The approval is advisory until tag creation is restricted: anyone with write access can still
  run `git push origin 3.1.0` from a laptop and publish. A ruleset on `refs/tags/*` with
  `creation`, `update` and `non_fast_forward`, and the App as the only bypass actor, would close
  it. It costs a toggle for break-glass recovery, and it blocks hand-cut prereleases, because
  `bump()` cannot bump from a prerelease version.
- A release PR now needs a changelog PR before it: rename `## [Unreleased]` to
  `## [X.Y.Z] - date`, re-add an empty `## [Unreleased]` (without it the check reports a missing
  heading), merge, and dispatch before any other PR adds notes.
- A dry run proves the preflight and the token, not the file serialisation: `DRY_RUN` also skips
  the three file writes.
- `required_signatures` is off. Enabling it later would break a CLI-committing bot, and the
  commits would have to be made through the Contents API instead.

### Open question

Requiring the changelog heading first makes the script's tolerance for a dirty `CHANGELOG.md`
dead weight in CI, and adds the very PR its docblock wanted to avoid. Option A3 is the way out and
is worth revisiting once the flow has cut a few releases.
