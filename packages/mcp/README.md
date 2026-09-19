# GitDocket MCP server

Install with Node 22 or later: `npm install -g --include=optional @gitdocket/cli @gitdocket/mcp`. The `docket-mcp` command uses the same standalone release as the CLI and needs no separate Bun installation. Supported platforms are macOS and glibc Linux on arm64/x64.

`docket-mcp --version` reports the installed release. Run `docket init --agent cursor --agent claude --agent codex` from the CLI to prepare supported project integrations, or configure your host to launch `docket-mcp` in the project directory. The server keeps stdout reserved for MCP messages. See [npm installation and migration](https://github.com/GitDocket/gitdocket/blob/main/docs/npm.md).
