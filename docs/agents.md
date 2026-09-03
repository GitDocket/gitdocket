# Coding-agent integration

GitDocket separates deterministic mechanics from judgment. The CLI owns parsing, status transitions, IDs, indexing, and search. Markdown workflows in each bundle explain how an agent should pick up, create, groom, close, report, and supervise work.

`docket init` always writes a portable `AGENTS.md` section. Native adapters are optional:

```sh
docket init --agent codex
docket init --agent claude
docket init --agent codex --agent claude
```

Adapters point back to the bundle workflows; they are not a second source of policy. Existing hand-authored configuration is preserved, and malformed or unavailable MCP configuration is reported rather than overwritten.

The `docket-mcp` binary exposes narrow, schema-validated operations for clients that support the Model Context Protocol. It resolves the nearest `docket.yaml` from the working directory, just like the CLI.

Direct implementation requests do not implicitly select backlog work. A Docket ID, an unambiguous existing item, or an explicit request to choose the next Docket task is required before tracked pickup changes state.
