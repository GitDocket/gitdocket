# Homebrew distribution

Install GitDocket 0.4.1 with Homebrew and Git:

```sh
brew install gitdocket/tap/gitdocket
docket --version
docket-mcp --version
```

One formula supplies both commands without separately installing Bun, Node or npm. Continue with [Getting started](getting-started.md), or use the [npm alternative](npm.md) if you already have Node 22+.

## Support and trust

The project-maintained tap is `GitDocket/homebrew-tap`; its formula is `gitdocket`. It is separate from Homebrew core and uses the same checked, versioned standalone archives as the other distribution channels. It does not use a cask. Linux qualification uses Ubuntu 24.04 on ARM64 and x64. Mac release checks run locally on Apple Silicon, including Intel compatibility through Rosetta; receipts record the actual macOS version and execution assistance. Rosetta does not establish testing on physical Intel hardware or an older macOS release. The formula requires macOS 15 or later and 64-bit ARM or Intel hardware; Linux must satisfy Homebrew's own supported-system requirements. Other Linux distributions and older OS releases have not been qualified. Windows is outside this release's scope.

Homebrew 6 and later require trust for third-party formulae. A fully qualified `brew install gitdocket/tap/gitdocket` grants trust to that formula, keeping installation to one command. It does not trust all future tap content. See [Homebrew tap trust](https://docs.brew.sh/Tap-Trust).

## Updating and removing

Use `brew update` followed by `brew upgrade gitdocket/tap/gitdocket`. `brew reinstall gitdocket/tap/gitdocket` repairs the installed package; `brew uninstall gitdocket/tap/gitdocket` removes it. Homebrew manages its own executable files. These commands do not migrate or delete project bundles, authored Markdown, agent configurations or hooks.

Inside each project, review `docket upgrade --dry-run --json`, then run `docket upgrade` and resolve any reported instruction conflicts. Updating the executable does not imply that project instructions have been reconciled.

## Moving from npm or Bun

Before switching channels, run `type -a docket docket-mcp` to see which executables your shell resolves. Inspect the existing installation with `npm ls -g --depth=0` or `bun pm ls -g`, depending on the installer you used. Install the Homebrew package, then inspect its commands directly with `$(brew --prefix gitdocket/tap/gitdocket)/bin/docket --version` and the corresponding `docket-mcp --version`.

If Homebrew reports an existing link collision, review the named paths and uninstall only the prior GitDocket packages with their original package manager: `npm uninstall -g @gitdocket/cli @gitdocket/mcp` or `bun remove -g @gitdocket/cli @gitdocket/mcp`. Do not force-overwrite unknown executable paths. Then run `brew link gitdocket/tap/gitdocket`, refresh your shell's command cache or open a new terminal, and rerun `type -a docket docket-mcp` and both version commands. An earlier directory on PATH can still select another installation even when Homebrew linking succeeds.

Agent MCP configurations can contain an absolute path to the old executable. Review `.mcp.json`, `.codex/config.toml` and any host-level MCP configuration. Point intentional custom entries at the selected `docket-mcp`. Re-running `docket init --agent claude --agent codex` applies normal preservation rules and may leave an existing custom MCP entry untouched; inspect the result and restart the agent host. Removing a package does not remove project files or rewrite those entries for you.

## Maintaining the tap

Build and verify all native standalone artifacts from the exact public release source, then run:

```sh
bun scripts/homebrew-tap.ts --artifacts release/standalone --output release/candidates/homebrew-tap
```

The generator verifies every archive, checksum, native smoke and source/export identity before writing `Formula/gitdocket.rb`, a README and `release.json`. The formula pins all four URLs to one release version with independent SHA-256 checksums. A local `--development` rehearsal remains nonpublishable evidence. Review the generated formula and receipt, run `brew audit --strict`, `brew style`, `brew install` and `brew test` in a disposable tap, and test reinstall/upgrade/uninstall before promotion.

Publish the tap update only after the exact GitHub release and all its assets are publicly available and match the receipt. A failed or partial artifact publication leaves the prior formula unchanged; repair or retry the same immutable release through the release procedure. Never replace published archive bytes or point the formula at a moving source branch. Current Homebrew core policies require a separate source/bottle submission strategy if core inclusion is pursued later.

The reusable standalone workflow runs `scripts/homebrew-qualify.ts` on Linux ARM64/x64 at standard prefixes after importing the locally qualified Mac assets. Run the same harness locally for macOS ARM64 and Intel through Rosetta; retain the actual OS, prefix and architecture in each receipt. GitHub Actions must not use macOS runners. This harness is only for disposable prefixes or ephemeral machines: it installs, revises and removes a temporary candidate formula. It uses a local file mirror of the exact source-bound archives until public URLs exist, with an explicit fixture version to replace GitHub URL version detection. The public formula remains unchanged. The receipt retains the mirror assistance, source/hash identity, runtime isolation, preserved adopter files, command precedence, deliberate custom MCP migration, and failed checksum/download behavior. Final launch qualification must additionally exercise the public URL.

The generated tap also includes a public-installation workflow. After publication it verifies real Homebrew, GitHub Release and npm acquisition on both Linux targets, checking source identity, installed binary hashes and full product/upgrade smoke. Run `scripts/public-install-smoke.ts` separately on this Mac for ARM64 and Intel through Rosetta with matching architecture tools and clean isolated prefixes. Retain all four receipts before promoting new installation documentation or deploying the matching website. Local mirror evidence never substitutes for public endpoint verification.
