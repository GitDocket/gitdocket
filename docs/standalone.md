# Standalone distribution development

GitDocket 0.4.0 distributes standalone CLI and MCP executables through [Homebrew](homebrew.md) and [npm](npm.md). This page describes their build and qualification process; ordinary installation does not require the build tools.

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

The standalone CI workflow builds and executes Linux ARM64/x64 on ordinary pushes and pull requests. macOS ARM64/x64 archives are built and exercised locally from the exact same public export. After combining all four archives, run `release:pack`, then `scripts/npm-qualify.ts` with Node 22/npm 11.17.0 and `scripts/homebrew-qualify.ts` in each Mac architecture environment, using an isolated Homebrew prefix. Name the receipts `npm-darwin-arm64.json`, `npm-darwin-x64.json`, `homebrew-darwin-arm64.json` and `homebrew-darwin-x64.json` in `release/standalone`. The receipts identify the host OS, execution architecture, Rosetta assistance, source and archive checksum. A Rosetta result does not establish testing on a physical Intel Mac or on an older macOS release.

`scripts/macos-qualification.ts --artifacts release/standalone` verifies the complete archive set plus both Mac channel receipts, including historical upgrades. For a full hosted qualification, the optional `macos_release_tag` dispatch input names a draft release containing the six Mac archive/manifest/checksum files and four channel receipts. Without that input, only Linux native jobs run; this is not complete release qualification. Publication requires the reviewed draft `candidate-v<version>`, imports its Mac assets on Linux and runs the Linux npm/Homebrew checks before protected registry publication. GitHub requires push access to see drafts, so only the import job receives `contents: write`; it downloads assets without checking out or running repository code. Build and channel-check jobs retain `contents: read`, and the reusable publication caller permits the import job’s required access. Every archive, checksum, embedded build identity and Mac channel receipt must match the unchanged export. Missing targets, source/version drift and compile-only evidence fail preflight. GitHub release completion attaches and verifies the same archives and receipts alongside the registry receipt. Exact reruns are accepted; conflicting existing assets stop the release instead of overwriting published bytes. Tap promotion follows successful publication and verification of the complete GitHub release.

Archive metadata fixes file modes, owners and timestamps, and compression uses the pinned Bun runtime instead of the host gzip. This keeps repeat native builds from changing checksums merely because the machine has a different gzip version. The npm route packages these exact extracted executable bytes, with exact-version platform dependencies.
