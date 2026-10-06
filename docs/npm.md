# Install with npm

GitDocket 0.6.4 is a public preview: expect rough edges and review agent changes. Public preview describes product maturity; the published packages use the latest channel and the GitHub release is not marked as a prerelease. See the [0.6.4 release notes](https://github.com/GitDocket/gitdocket/releases/tag/v0.6.4).

If you use Node 22 or later, install GitDocket with npm and verify both commands:

```sh
npm install -g --include=optional @gitdocket/cli @gitdocket/mcp &&
  docket --version &&
  docket-mcp --version
```

If installation fails or your agent cannot find Docket, check the [supported platforms](homebrew.md#supported-platforms) and [command-path guidance](homebrew.md#moving-from-npm-or-bun), or [ask for help](#help-and-feedback).

This installs the command-line tool and the MCP server for your coding agent. Keep optional dependencies enabled: they supply the executable for your platform. The supported platforms are macOS 15+ and glibc Linux on ARM64 or x64; see [platform details](homebrew.md#supported-platforms).

Continue with [Getting started](getting-started.md).

## Run with npx

For a temporary invocation:

```sh
npx --yes --package=@gitdocket/cli --package=@gitdocket/mcp docket --version
```

To initialize a project with npx, first open its Git repository in your terminal. This example enables all three agent adapters; omit any --agent option you do not use:

```sh
npx --yes --package=@gitdocket/cli --package=@gitdocket/mcp docket init --agent cursor --agent claude --agent codex
```

Omit `--yes` if you want npm to ask before downloading packages. Pin both package versions when you need a reproducible invocation.

npx makes commands available only for that invocation. For an agent that starts MCP later, use a global installation or configure its MCP command as `npx --yes --package=@gitdocket/mcp@<version> docket-mcp`. Restart the agent after changing that command.

## Updating and removing

Update with `npm update -g @gitdocket/cli @gitdocket/mcp`, or remove the packages with `npm uninstall -g @gitdocket/cli @gitdocket/mcp`. Your project files stay in place.

After an application update, run `docket upgrade --dry-run --json` in each project, review the changes, then run `docket upgrade`. Resolve any conflicts with your customized instructions.

A Bun global installation uses a separate package manager. Follow the [migration guide](homebrew.md#moving-from-npm-or-bun) when switching installers or resolving command collisions.

## Help and feedback

Stuck during setup, or unsure what to do next? [Open a GitHub issue](https://github.com/GitDocket/gitdocket/issues/new/choose) or [email me at hello@gitdocket.com](mailto:hello@gitdocket.com) and tell me what you tried. GitHub sign-in is required. Rough impressions and quick notes are welcome; you do not need a diagnosis or a reproducible example to share feedback.

For a bug, include whatever details you have: the GitDocket version (`docket --version`, if it runs), operating system, coding agent, what you expected, what happened, and steps to reproduce it. A small synthetic example helps. Missing details should not stop you from reporting a problem.

Keep private project content, credentials and personal details out of public issues. Compare your installed version with the [release notes](https://github.com/GitDocket/gitdocket/releases) to see what changed.

## Release preparation

Local Ubuntu 24.04 Docker and macOS checks first qualify all four standalone archives from the unchanged public export. Mac npm qualification uses matching Node 22 and Bun architectures, records the source/archive identity, and identifies Intel execution through Rosetta. Linux receipts identify the container distribution and any architecture emulation. See [local qualification](standalone.md#release-archives). `bun run release:pack` verifies that complete set, then packages the four platform dependencies plus `core`, `web`, `cli` and `mcp`. Platform packages reuse the extracted archive bytes; launcher manifests bind the identical source/export identity and exact package versions. Source-only inspection with `bun run release:pack --source-only` is a private preparation check and does not produce a publishable binary release.

Local staging takes the qualified matrix artifacts with `bun run release -- stage --plan <plan> --destination <public-checkout> --standalone <artifact-directory>`. It verifies their exact source/export identity before packing and testing real npm global/npx installation with Bun absent from product PATH. Current receipts bind all eight tarballs; older four-package schema-1 receipts remain readable. Registry publication stages platform dependencies before launchers, requires the complete set and trusted-publisher provenance, runs registry-only installation smoke, then promotes `latest`. A missing or conflicting platform prevents launcher promotion. Reruns reuse correct immutable versions and resume only missing work.

Before the first standalone release, configure npm ownership and trusted publishing for all four new platform package names as well as the existing packages. That external setup and public publication remain explicit release steps. The local test registry is read-only and serves exact candidate bytes; it never publishes a package or proxies a missing candidate from the public registry.
