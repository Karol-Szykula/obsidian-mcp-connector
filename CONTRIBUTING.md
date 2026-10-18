# Contributing to MCP Connector

## Community Standards

This is a **free, open-source project** maintained by volunteers in their spare time. We welcome genuine contributions and constructive discussions, but we have **zero tolerance** for toxic behavior.

### Unacceptable Behavior
- Demanding features or fixes
- Rude, dismissive, or condescending language
- Entitlement or treating maintainers like paid support
- Shaming contributors for mistakes or decisions
- Aggressive or impatient language in issues or discussions

### Consequences
**One strike policy**: Any toxic, demanding, or rude behavior results in an immediate ban from both the GitHub repository and Discord server.

### Before You Post
Think before you post. Ask yourself:
- Am I being respectful and constructive?
- Would I talk this way to a volunteer helping me for free?
- Am I treating maintainers like human beings, not paid support staff?

**Remember**: We don't owe anyone anything. This is a gift to the community, and we expect contributors to act accordingly.

## Getting Help & Community

- **Discord**: [Join our community](https://discord.gg/q59pTrN9AA) for discussions and support
- **Issues**: Use GitHub issues for bug reports and feature requests (following our guidelines)
- **Discussions**: Use GitHub Discussions for questions and general help

## Development Setup

1. **Prerequisites**:
   - [Bun](https://bun.sh/) v1.4.2 (the version the release workflow pins; another version builds, but `main.js` can differ byte for byte)
   - [Obsidian](https://obsidian.md/) v1.7.2 or higher (`minAppVersion` in `manifest.json`)
   - An MCP client for testing, such as [Claude Desktop](https://claude.ai/download), Claude Code or Codex

2. **Clone and Setup**:
   ```bash
   git clone https://github.com/istefox/obsidian-mcp-connector.git
   cd obsidian-mcp-connector
   bun install
   ```

3. **Development**:
   ```bash
   bun run dev     # Development mode with watch
   bun run build   # Production build
   bun test        # Run tests
   ```

## Project Architecture

### Documentation Resources
- **Project architecture**: `/docs/project-architecture.md`
- **Feature documentation**: `/docs/features/`

### Monorepo Structure
```
packages/
├── obsidian-plugin/   # The plugin: in-process MCP server, tools, settings UI (TypeScript/Svelte)
├── shared/            # Shared ArkType schemas and types
└── test-site/         # SvelteKit harness (dev-only, not shipped)
```

### Feature-Based Architecture
- Self-contained modules in `src/features/` with standardized structure
- Each feature exports a setup function for initialization
- Use ArkType for runtime type validation
- Follow the feature structure in `/docs/project-architecture.md`

## Contributing Guidelines

### Submitting Issues
**Before creating an issue**:
- Search existing issues to avoid duplicates
- Provide clear, detailed descriptions
- Include system information and steps to reproduce
- Be respectful and patient - remember this is volunteer work

**Good issue example**:
> **Bug Report**: MCP server fails to start on macOS 14.2
> 
> **Environment**: macOS 14.2, Obsidian 1.7.7, Claude Desktop 1.0.2
> 
> **Steps to reproduce**: 
> 1. Install plugin from Community Plugins
> 2. Click "Install Server" in settings
> 3. Server download completes but fails to start
> 
> **Expected**: Server starts and connects to Claude
> **Actual**: Error in logs: [paste error message]
> 
> **Additional context**: Logs attached, willing to test fixes

### Pull Requests

> **Forked before June 2026?** This repository was detached from the original `jacksteamdev/obsidian-mcp-tools` fork network on 2026-05-31 and is now standalone. A fork created before that date still belongs to the old network, and GitHub will refuse cross-fork PRs against this repo (`gh pr create` fails with "No commits between …" or "not all refs are readable"). Delete the stale fork and re-fork from this repository — a one-time operation.

1. **Fork [istefox/obsidian-mcp-connector](https://github.com/istefox/obsidian-mcp-connector)** and create a feature branch
2. **Follow the architecture patterns** described in `/docs/project-architecture.md`
3. **Write tests** for new functionality
4. **Test thoroughly**:
   - Local Obsidian vault integration
   - MCP server functionality  
   - Claude Desktop connection
5. **Submit PR** with clear description of changes

### Code Standards
- **TypeScript strict mode** required
- **ArkType validation** for all external data
- **Error handling** with descriptive messages
- **Documentation** for public APIs
- **Follow existing patterns** in `/docs/project-architecture.md` and the neighbouring feature code

## Release Process (Maintainers Only)

### Creating Releases

A release is cut in two phases with a human gate between them. `main` refuses a direct push, so
neither phase pushes it: the first opens a pull request, the second tags the merged commit.
See [ADR-0030](docs/architecture/ADR-0030-release-from-actions.md) for why.

1. **Write the release notes.** In an ordinary PR, rename `## [Unreleased]` in `CHANGELOG.md` to
   `## [X.Y.Z] - date` and add an empty `## [Unreleased]` above it. Without the empty heading the
   release check reports a missing one. Merge it, then go to step 2 before any other PR adds notes.

2. **Prepare** (Actions tab, workflow **Release prepare**): pick `part` (patch, minor, major).
   Tick `dry_run` first on a change to the release tooling. It bumps `package.json`,
   `manifest.json` and `versions.json`, commits as the App's bot, pushes `chore/release-X.Y.Z`
   and opens the PR. Nothing is published. It refuses a changelog that is not ready, a tag that
   already exists, or a release branch already in flight.

3. **Merge the release PR** once `check-and-test` and `bridge-tests` pass. Squash or a merge
   commit are both fine: the tag is created afterwards and points at whatever `main` has.

4. **Approve the tag** (workflow **Release tag**). Every push to `main` runs it. It asks for your
   approval only when HEAD is an untagged release, and the job summary lists the version, the
   commit and the changes since the last tag. **Approving is the point of no return.** If `main`
   moved while it waited, the job refuses: re-run it at the new head instead of forcing. A red
   `detect` job means an untagged version whose files or changelog disagree; fix the cause and
   push, or dispatch the workflow again.

5. **Automated build**: pushing the tag starts `release.yml`, which handles:
   - Plugin bundle build (`bun.config.ts` → `main.js`) — no binary
   - GitHub build-provenance attestation for `main.js`
   - Release artifact upload (`main.js` + `manifest.json`)

6. **Release notes**: GitHub appends generated notes from the merged PRs to the release.

**Fallback, from a terminal**, when Actions is unavailable: `bun run version <part>`, merge the PR,
`git checkout main && git pull --ff-only`, then `bun run version:tag`. The tag push is refused while
the ruleset `release-tags-via-actions` is active (only the App may create a tag), so switch it off
in Settings, Rules first and back on afterwards. `DRY_RUN=1` on either
prints every mutating command and still runs every read-only check. `bun run version:check` says
whether HEAD is a release still waiting for its tag.

**One-time setup** (repository admin): a GitHub App with Contents and Pull requests write and
Metadata read, installed on this repository only; the secret `RELEASE_APP_PRIVATE_KEY` and the
variable `RELEASE_APP_CLIENT_ID`; environments `release-prepare` (no reviewers) and `release`
(required reviewer, "Prevent self-review" off), both limited to the `main` branch; a tag ruleset on
`refs/tags/*` (`creation`, `update`, `non_fast_forward`) with the App as its only bypass actor.

### Alpha pre-releases

An alpha goes to testers who install through [BRAT](https://github.com/TfTHacker/obsidian42-brat),
never to the store. Run the workflow **Release alpha** from `main` with `base_version` (the version
the alpha leads up to, higher than the stable one, for example `3.1.0`) and `alpha_number`. It
validates the version, waits for your approval in the `release` environment, then tags a commit that
carries `X.Y.Z-alpha.N` in `package.json` and `manifest.json`. `main` does not change, so the store,
which reads the version from `manifest.json` on `main`, never sees it, and `release.yml` publishes
the tag as a prerelease. The base must be higher than the stable version: `3.0.3-alpha.1` sorts
before `3.0.3`. See ADR-0030, "Amendment: alpha pre-releases".

### Maintainer Responsibilities
- **Code review**: Review PRs for quality, security, and architecture compliance
- **Issue triage**: Respond to issues and help users (when possible)
- **Release management**: Create releases following security protocols
- **Community management**: Enforce community standards
- **Documentation**: Keep docs current and comprehensive

### Access Requirements
- **GitHub**: "Maintain" or "Admin" access to repository
- **Discord**: Moderator permissions for community management
- **Time commitment**: 5-10 hours per week (15-20 during releases)

## Testing Guidelines

### Local Testing
```bash
# Unit tests
bun test

# Integration testing with local vault
# 1. Set up test Obsidian vault
# 2. Build plugin locally: `bun run build` (outputs main.js + manifest.json at repo root)
# 3. Test MCP server connection with Claude Desktop
# 4. Verify all features work end-to-end
```

## Security Considerations

### Binary Security

These notes apply to the legacy 0.3.x binary line. The current 3.x line ships no standalone binary — the only artifact is the plugin bundle (main.js), attested at release.

- All binaries are SLSA-attested and cryptographically signed
- Use `gh attestation verify --owner istefox <binary>` to verify integrity
- Report security issues via the [security policy](SECURITY.md)

### Development Security
- **No secrets in code**: Use environment variables for API keys
- **Input validation**: Use ArkType for all external data
- **Minimal permissions**: MCP server runs with least required access
- **Audit dependencies**: Regularly update and audit npm packages

## Resources

- **GitHub Repository**: [istefox/obsidian-mcp-connector](https://github.com/istefox/obsidian-mcp-connector)
- **Discord Community**: [Join here](https://discord.gg/q59pTrN9AA)
- **Release History**: [GitHub Releases](https://github.com/istefox/obsidian-mcp-connector/releases)
- **Security Policy**: [SECURITY.md](SECURITY.md)

## Questions?

Join our [Discord community](https://discord.gg/q59pTrN9AA) for questions and discussions. Please read this document thoroughly before asking questions that are already covered here.

**Remember**: Be respectful, be patient, and remember that everyone here is volunteering their time to help make this project better.
