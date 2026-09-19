# Coding-agent integration

Connect your coding agent to the project’s docs and tasks. GitDocket provides tools to read and update them, plus editable Markdown workflows that guide the agent through planning, implementation, checks, and documentation updates.

`docket init` always writes a portable `AGENTS.md` section. Native adapters are optional:

```sh
docket init --agent cursor
docket init --agent codex
docket init --agent claude
docket init --agent cursor --agent claude --agent codex
```

The adapters connect your agent to the workflows in the bundle. Init preserves your existing custom configuration and reports any setup problems. For Cursor, enable Docket once in Customize → MCPs after initialization.

Homebrew installs `docket` and `docket-mcp` together. With the [npm alternative](npm.md), install both `@gitdocket/cli` and `@gitdocket/mcp`. Run `docket-mcp --version` to verify the command. When switching installers, review any absolute MCP command paths and restart the agent host; see [migration](homebrew.md#moving-from-npm-or-bun).

For other clients that support the Model Context Protocol, configure a stdio server that runs `docket-mcp` with the project repository as its working directory. It finds the nearest `docket.yaml`, just like the CLI.

Name a task or epic when you want the agent to work on it. You can also ask it to choose the next ready task. A direct request such as “fix this typo” stays separate from your backlog.

## Guidance management

Ask your agent to “remember that we use GraphQL for backend APIs”, “show our project instructions”, “update the deployment steps” or “retire this instruction”. The optional project-owned entry point is `reference/project-guidance.md` inside your configured bundle. The `docket-guidance` workflow reuses existing sources, keeps scope in plain language and distinguishes requirements from preferences. Inspection is read-only; saving guidance does not pick up a task or execute a stored procedure. Source changes become available to fresh sessions or an explicit reread, subject to the host instruction hierarchy.

Read current guidance with `docket guidance --json`; an absent result requires no setup. The output carries exact source, diagnostics and a continuation cursor for long documents. Use `docket source <path> --json` to follow remaining pages and relevant linked procedures. MCP clients use the read-only `project_guidance` and `source_page` tools. Tracked pickup includes the same guidance in its context packet. Generated repository instructions tell agents to read general guidance before planning and open scoped procedures only when relevant. After a guidance change, ask an ongoing agent to reread it or begin a fresh session.

Project-authored guidance and linked sources survive initialization and upgrades. Generated pointers and vendored workflows have separate ownership; upgrade reports conflicting workflow edits for resolution. `docket lint` diagnoses broken explicit guidance links and unresolved merge markers. Close-time reconciliation and freshness preserve selected standards when implementation diverges, reporting the discrepancy instead of silently changing the rule. Retiring a guidance link does not delete a shared document.

## Installed workflow packages

[Extension workflows](extensions.md) use qualified identities and thin native pointers. Reread current availability/configuration through `docket extension show` or MCP `workflow_extensions`, then the complete canonical source using `source_page`. Package guidance stays scoped; unavailable or ambiguous tools never authorize invented results. Generated adapters and actual host qualification are separate evidence.
