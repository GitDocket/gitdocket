# GitDocket Homebrew tap

This is the project-maintained formula for GitDocket. Install both `docket` and `docket-mcp` with:

```sh
brew install gitdocket/tap/gitdocket
```

The formula installs checksummed standalone executables. It needs no separate Bun, Node or npm installation. Git is required. The supported architectures are Apple Silicon and Intel on macOS 15 or later, and ARM64 and x64 Linux with Homebrew; Linux qualification uses Ubuntu 24.04; Mac checks run locally and record their actual OS and any Rosetta assistance. Windows and 32-bit platforms are not supported. See [installation details](https://github.com/GitDocket/gitdocket/blob/main/docs/homebrew.md) for compatibility and migration.

The fully qualified install command grants trust to this formula. It does not grant trust to every item in the tap. Homebrew 6 and later require explicit trust for third-party taps; see [Homebrew tap trust](https://docs.brew.sh/Tap-Trust). This tap is maintained by GitDocket and is separate from Homebrew's official repositories.

```sh
brew update
brew upgrade gitdocket/tap/gitdocket
brew reinstall gitdocket/tap/gitdocket
brew uninstall gitdocket/tap/gitdocket
```

Package operations change the installed executables only. Projects and their Markdown remain where you created them. Review `docket upgrade --dry-run --json` inside each project before applying `docket upgrade`; package upgrades do not automatically rewrite project instructions.

`release.json` records the version, source/export identity, exact formula hash and release asset hashes used to prepare this tap revision. Maintainers generate updates from the qualified standalone set, verify that the identical release assets are publicly downloadable, run formula audit/style and native installation tests, and review the tap diff before promotion. Do not point a formula at a mutable branch or substitute an asset under an existing release version. A failed or incomplete release leaves the prior tap revision in place.

The public-installation workflow checks fresh installs on Linux ARM/Intel after a tap push. GitHub Actions uses Linux runners only; run the same `scripts/public-install-smoke.ts` from the exact GitDocket release locally on macOS ARM64 and Intel through Rosetta, with matching architecture tools and clean isolated Homebrew prefixes. It downloads the actual GitHub Release receipt, checks installed executable hashes and source identity, and exercises basic CLI, browser, MCP and registry-only npm/npx behavior. Deep historical/customized/stale upgrade checks run against the exact candidate packages during representative Mac and Linux qualification. Retain both Linux receipts and both local Mac receipts, including host OS and Rosetta assistance, before promoting the matching GitDocket documentation and website. The verification harness uses development tools on ephemeral runners; installed Homebrew product subprocesses have only Git and the standalone commands on PATH.
