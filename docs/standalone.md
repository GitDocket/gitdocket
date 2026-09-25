# Standalone distribution development

GitDocket 0.5.0 distributes standalone CLI and MCP executables through [Homebrew](homebrew.md) and [npm](npm.md). This page describes their build and qualification process; ordinary installation does not require the build tools.

Build both commands from a development checkout with its frozen dependencies installed:

```sh
bun run standalone:build --target darwin-arm64 --output dist/standalone/darwin-arm64
bun run standalone:smoke --bin dist/standalone/darwin-arm64
```

The compiler includes the Bun runtime, browser JavaScript/CSS, canonical workflows and retained upgrade history. Installed executables need no separate Bun, Node or npm installation. Git remains necessary for Git history, hooks and three-way project upgrades. `docket-mcp --version` reports the same release as `docket --version` without requiring an initialized project.

Build targets are `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64`; the Linux x64 build uses Bun's baseline target. Release qualification requires archive, npm and Homebrew checks for all four targets. GitHub Actions uses Linux runners only; macOS checks run on the owner’s Mac, with Intel execution through Rosetta explicitly recorded. Public endpoint verification follows publication. Windows is outside the current support scope.

The smoke copies only the executables into a disposable installation and restricts product subprocesses to a PATH containing Git and Docket. The test harness itself uses Bun. It checks dual-agent initialization, task operations, index consistency, served browser assets, an actual MCP tool call and historical/customized/stale workflow upgrades. A successful compile or version command alone is insufficient. The smoke needs permission to bind an IPv4 loopback port.

Standalone `docket serve` uses embedded release assets. `serve --watch` requires the source installation and reports that requirement in a standalone executable; normal source watch mode remains available for development.

## Release archives

With Bun 1.3.14, `bun run release:standalone build` packages the native target from a verified public export. It refuses changed export files and includes both executables, the project license, dependency notices and `BUILD.json` with the version, compiler, target and canonical source/export identity. Each `gitdocket-<version>-<os>-<arch>.tar.gz` has a SHA-256 sidecar and a target JSON receipt containing individual file hashes and the smoke result from the extracted archive. `--development` permits local experimentation but produces evidence that publication rejects.

Linux qualification runs locally in Ubuntu 24.04 Docker containers. From a committed canonical release candidate, `bun run release -- linux --plan <plan.json> --source <new-export> --output <linux-artifacts>` creates the public-shaped export, builds both Linux targets and exercises the extracted archives. The Docker engine must support Linux ARM64 and amd64. The receipt names the exact source/export, image IDs, artifact hashes and native-versus-emulated execution; emulated x64 on ARM64 does not establish physical x64 hardware testing.

Build and exercise both Mac archives from the identical export using matching Bun 1.3.14, Node 22 and npm 11.17.0 tools, with disposable Homebrew prefixes. `release qualify` with `linuxDocker: true` combines the Linux archives, builds/checks Mac ARM64 and Intel through Rosetta, packs all eight packages, and exercises Linux npm/Homebrew in Docker, including Node 24 x64. Receipts identify the actual host OS/distribution and translation assistance. To repeat Linux channel checks after all four archives exist, run `bun run release -- linux --mode channels --source <export> --output <export>/release/standalone`.

`scripts/macos-qualification.ts --artifacts release/standalone --linux` verifies all four archives and installed-channel receipts, plus both READY Docker summaries. Preserve twelve native assets, four Mac channel receipts, five Linux channel receipts and the two Docker summaries. Ordinary pushes and PRs do not start standalone builds. The manually dispatched workflow can run diagnostic Linux native builds, or import the complete reviewed local set using `qualified_release_tag`; the native fallback alone is not complete qualification.

Publication requires the reviewed draft `candidate-v<version>` containing that complete set. Only the draft importer receives `contents: write`, needed to see drafts; it downloads assets without checking out or running repository code. The read-only preflight verifies source/export identities, checksums, installed checks and emulation evidence before protected registry publication. Missing targets, stale receipts, source/version drift and compile-only evidence fail preflight. GitHub release completion attaches the same standalone assets alongside the registry receipt. Exact reruns are accepted; conflicting existing assets stop the release instead of overwriting published bytes. Tap promotion follows successful publication and verification of the complete GitHub release.

Archive metadata fixes file modes, owners and timestamps, and compression uses the pinned Bun runtime instead of the host gzip. This keeps repeat native builds from changing checksums merely because the machine has a different gzip version. The npm route packages these exact extracted executable bytes, with exact-version platform dependencies.
