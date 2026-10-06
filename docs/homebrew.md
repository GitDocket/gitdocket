# Install with Homebrew

GitDocket 0.6.4 is a public preview: expect rough edges and review agent changes. Public preview describes product maturity; the published packages use the latest channel and the GitHub release is not marked as a prerelease. See the [0.6.4 release notes](https://github.com/GitDocket/gitdocket/releases/tag/v0.6.4).

Install GitDocket with Homebrew and verify both commands:

```sh
brew install gitdocket/tap/gitdocket &&
  docket --version &&
  docket-mcp --version
```

If installation fails or your agent cannot find Docket, check the [supported platforms](#supported-platforms) and [command-path guidance](#moving-from-npm-or-bun), or [ask for help](#help-and-feedback).

This installs `docket`, the command-line tool, and `docket-mcp`, which connects your coding agent to the project. Continue with [Getting started](getting-started.md). If you already use Node 22+, [npm](npm.md) is another installation option.

## Supported platforms

You need Git and Homebrew. GitDocket supports:

- macOS 15 or later on Apple Silicon or Intel.
- Homebrew-compatible glibc Linux on ARM64 or x64. Release checks use Ubuntu 24.04; other distributions have not been qualified.

Windows, Alpine/musl Linux and 32-bit systems are unsupported. Mac release checks run on Apple Silicon, with Intel compatibility checked through Rosetta rather than physical Intel hardware. Linux must meet [Homebrew’s system requirements](https://docs.brew.sh/Installation).

## About the tap

The command uses the project-maintained `GitDocket/homebrew-tap`. On Homebrew 6 and later, the fully qualified command grants trust to this formula. See [Homebrew tap trust](https://docs.brew.sh/Tap-Trust).

## Updating and removing

Update the application with:

```sh
brew update &&
  brew upgrade gitdocket/tap/gitdocket
```

From each initialized project directory, preview the supplied-instruction changes:

```sh
docket upgrade --dry-run --json
```

Review the dry-run output and resolve any reported conflicts with your customizations before applying the update:

```sh
docket upgrade
```

Use `brew reinstall gitdocket/tap/gitdocket` to repair the installation, or `brew uninstall gitdocket/tap/gitdocket` to remove it. Your project files and agent configuration stay in place.

## Moving from npm or Bun

Check which commands your shell currently uses:

```sh
type -a docket docket-mcp
```

Inspect your previous installation with `npm ls -g --depth=0` or `bun pm ls -g`, depending on the installer you used. Install the Homebrew package, then check it directly with `$(brew --prefix gitdocket/tap/gitdocket)/bin/docket --version` and the corresponding `docket-mcp --version`.

If Homebrew reports a link collision, remove the old GitDocket packages with their original installer: `npm uninstall -g @gitdocket/cli @gitdocket/mcp` or `bun remove -g @gitdocket/cli @gitdocket/mcp`. Review the named paths before removing anything; avoid force-overwriting unknown executables. Run `brew link gitdocket/tap/gitdocket`, open a new terminal, and check `type -a docket docket-mcp` again.

An agent may still point to the old executable through `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml` or its host-level MCP settings. Update any old absolute paths and restart the agent. Re-running `docket init` preserves custom entries, so check those yourself. For a new Cursor registration, enable Docket in Customize → MCPs.

## Help and feedback

Stuck during setup, or unsure what to do next? [Open a GitHub issue](https://github.com/GitDocket/gitdocket/issues/new/choose) or [email me at hello@gitdocket.com](mailto:hello@gitdocket.com) and tell me what you tried. GitHub sign-in is required. Rough impressions and quick notes are welcome; you do not need a diagnosis or a reproducible example to share feedback.

For a bug, include whatever details you have: the GitDocket version (`docket --version`, if it runs), operating system, coding agent, what you expected, what happened, and steps to reproduce it. A small synthetic example helps. Missing details should not stop you from reporting a problem.

Keep private project content, credentials and personal details out of public issues. Compare your installed version with the [release notes](https://github.com/GitDocket/gitdocket/releases) to see what changed.

## Maintaining the tap

Build and verify all native standalone artifacts from the exact public release source, then run:

```sh
bun scripts/homebrew-tap.ts --artifacts release/standalone --output release/candidates/homebrew-tap
```

The generator verifies every archive, checksum, native smoke and source/export identity before writing `Formula/gitdocket.rb`, a README and `release.json`. The formula pins all four URLs to one release version with independent SHA-256 checksums. A local `--development` rehearsal remains nonpublishable evidence. Review the generated formula and receipt, run `brew audit --strict`, `brew style`, `brew install` and `brew test` in a disposable tap, and test reinstall/upgrade/uninstall before promotion.

Publish the tap update only after the exact GitHub release and all its assets are publicly available and match the receipt. A failed or partial artifact publication leaves the prior formula unchanged; repair or retry the same immutable release through the release procedure. Never replace published archive bytes or point the formula at a moving source branch. Current Homebrew core policies require a separate source/bottle submission strategy if core inclusion is pursued later.

Local Ubuntu 24.04 Docker qualification runs `scripts/homebrew-qualify.ts` on Linux ARM64/x64 at standard prefixes after combining all four archives. Linux receipts disclose Docker emulation when the target differs from the engine architecture. Run the same harness locally for macOS ARM64 and Intel through Rosetta; retain the actual OS, prefix and architecture in each receipt. GitHub Actions must not use macOS runners. This harness is only for disposable prefixes or ephemeral machines: it installs, revises and removes a temporary candidate formula. It uses a local file mirror of the exact source-bound archives until public URLs exist, with an explicit fixture version to replace GitHub URL version detection. The public formula remains unchanged. The receipt retains the mirror assistance, source/hash identity, runtime isolation, preserved adopter files, command precedence, deliberate custom MCP migration, and failed checksum/download behavior. Final launch qualification must additionally exercise the public URL.

The generated tap also includes a public-installation workflow. After publication it verifies real Homebrew, GitHub Release and npm acquisition on both Linux targets, checking source identity, installed binary hashes and full product/upgrade smoke. Run `scripts/public-install-smoke.ts` separately on this Mac for ARM64 and Intel through Rosetta with matching architecture tools and clean isolated prefixes. Retain all four receipts before promoting new installation documentation or deploying the matching website. Local mirror evidence never substitutes for public endpoint verification.
