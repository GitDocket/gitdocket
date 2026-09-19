# npm distribution

GitDocket 0.5.0 supports npm as an alternative to [Homebrew](homebrew.md). Node 22 or later and npm are required. CLI/MCP commands use standalone binaries and need no separate Bun installation. Earlier 0.3.1 commands and the core/web library packages remain Bun-dependent.

With Node 22 or later and npm, the standalone release installs both commands through the existing package names:

```sh
npm install -g --include=optional @gitdocket/cli @gitdocket/mcp
docket --version
docket-mcp --version
```

The small launchers select exact-version `@gitdocket/bin-<os>-<arch>` dependencies. Those packages contain the same qualified binaries, build identity and licenses as the Homebrew archives. There is no install script, runtime download or source fallback. Keep optional dependencies enabled. This route supports macOS and glibc Linux on arm64 and x64; the native qualification matrix is shared with [Homebrew](homebrew.md). Musl/Alpine, Windows and 32-bit systems are unsupported.

For a temporary CLI invocation without a global installation, use:

```sh
npx --yes --package=@gitdocket/cli --package=@gitdocket/mcp docket --version
npx --yes --package=@gitdocket/cli --package=@gitdocket/mcp docket init --agent cursor --agent claude --agent codex
```

npm may ask before downloading packages when `--yes` is omitted. For a reproducible invocation, pin both package versions explicitly. npx makes the commands available only for that invocation. Generated MCP configuration names `docket-mcp`, which a later agent may not find; use a stable global installation for persistent MCP configuration, or configure the host explicitly to run `npx --yes --package=@gitdocket/mcp@<version> docket-mcp`. Restart the host after changing its MCP command.

Use `npm update -g @gitdocket/cli @gitdocket/mcp` to update both commands and `npm uninstall -g @gitdocket/cli @gitdocket/mcp` to remove them. Updates and removal preserve project bundles. Existing Bun-dependent npm packages upgrade under the same names. A separate Bun global installation uses a different package manager and must be reviewed separately. See the [PATH and MCP migration procedure](homebrew.md#moving-from-npm-or-bun) when switching channels or resolving command collisions. Project instruction reconciliation remains an explicit `docket upgrade --dry-run --json`, followed by a reviewed `docket upgrade`.

## Release preparation

Linux CI and local macOS checks first qualify all four standalone archives from the unchanged public export. Mac npm qualification uses matching Node 22 and Bun architectures, records the source/archive identity, and identifies Intel execution through Rosetta. See [local Mac qualification](standalone.md#release-archives). `bun run release:pack` verifies that complete set, then packages the four platform dependencies plus `core`, `web`, `cli` and `mcp`. Platform packages reuse the extracted archive bytes; launcher manifests bind the identical source/export identity and exact package versions. Source-only inspection with `bun run release:pack --source-only` is a private preparation check and does not produce a publishable binary release.

Local staging takes the qualified matrix artifacts with `bun run release -- stage --plan <plan> --destination <public-checkout> --standalone <artifact-directory>`. It verifies their exact source/export identity before packing and testing real npm global/npx installation with Bun absent from product PATH. Current receipts bind all eight tarballs; older four-package schema-1 receipts remain readable. Registry publication stages platform dependencies before launchers, requires the complete set and trusted-publisher provenance, runs registry-only installation smoke, then promotes `latest`. A missing or conflicting platform prevents launcher promotion. Reruns reuse correct immutable versions and resume only missing work.

Before the first standalone release, configure npm ownership and trusted publishing for all four new platform package names as well as the existing packages. That external setup and public publication remain explicit release steps. The local test registry is read-only and serves exact candidate bytes; it never publishes a package or proxies a missing candidate from the public registry.
