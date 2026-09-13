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

## Guidance management

Ask your agent to “remember that we use GraphQL for backend APIs”, “show our project instructions”, “update the deployment steps” or “retire this instruction”. The optional project-owned entry point is `reference/project-guidance.md` inside your configured bundle. The `docket-guidance` workflow reuses existing sources, keeps scope in plain language and distinguishes requirements from preferences. Inspection is read-only; saving guidance does not pick up a task or execute a stored procedure. Source changes become available to fresh sessions or an explicit reread, subject to the host instruction hierarchy.

Read current guidance with `docket guidance --json`; an absent result requires no setup. The output carries exact source, diagnostics and a continuation cursor for long documents. Use `docket source <path> --json` to follow remaining pages and relevant linked procedures. MCP clients use the read-only `project_guidance` and `source_page` tools. Tracked pickup includes the same guidance in its context packet. Generated repository instructions tell agents to read general guidance before planning and open scoped procedures only when relevant. This is an instruction-based discovery contract, not guaranteed model compliance. After a guidance change, ask an ongoing agent to reread it or begin a fresh session.

Project-authored guidance and linked sources survive initialization and upgrades. Generated pointers and vendored workflows have separate ownership; upgrade reports conflicting workflow edits for resolution. `docket lint` diagnoses broken explicit guidance links and unresolved merge markers. Close-time reconciliation and freshness preserve selected standards when implementation diverges, reporting the discrepancy instead of silently changing the rule. Retiring a guidance link does not delete a shared document.
