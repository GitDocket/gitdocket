# GitDocket CLI

Install with Node 22 or later: `npm install -g --include=optional @gitdocket/cli @gitdocket/mcp`. The standalone CLI release needs no separate Bun installation. It uses an exact-version platform package for macOS and glibc Linux on arm64/x64. Keep optional dependencies enabled.

Run `docket --version`, then `docket init --agent cursor --agent claude --agent codex` inside your project. See [Getting started](https://github.com/GitDocket/gitdocket/blob/main/docs/getting-started.md) and [npm installation and migration](https://github.com/GitDocket/gitdocket/blob/main/docs/npm.md). Project instruction upgrades remain an explicit `docket upgrade` operation.
