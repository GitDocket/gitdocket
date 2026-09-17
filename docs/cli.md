# CLI reference

GitDocket’s CLI is intentionally small. Use `--json` when another program or coding agent consumes a command.

| Command | Purpose |
| --- | --- |
| `docket init` | Adopt a repository additively and finish its first index/cache pass. |
| `docket overview` | Read the current project briefing, in-flight work, and next frontier. |
| `docket ready` | List tasks whose stored state and dependencies make them ready. |
| `docket guidance --json` | Read optional project guidance with exact source, link diagnostics and continuation. |
| `docket source <path> --json` | Read an exact bounded bundle source page; follow its returned cursor. |
| `docket search <terms>` | Search concepts and return their link neighborhood. |
| `docket task list` | List tracked work with filters. |
| `docket task create` | Create a conformant task, epic, or decision. |
| `docket task start <ID>` | Start or resume explicitly selected tracked work. |
| `docket task stop` | Clear the checkout-local active task without changing its status. |
| `docket task close <ID>` | Move completed work to `done`, or explicitly close without completion. |
| `docket lint` | Report schema, link, and workflow-hygiene problems. |
| `docket index` | Regenerate the committed index and rebuild the local cache. |
| `docket verify status` | Derive spec-to-test presence from source markers. |
| `docket upgrade` | Three-way merge newer vendored workflows and regenerate adapters. |
| `docket serve` | Open the local-only browser interface. |

Run `docket <command> --help` for flags and exact argument forms.

The 0.4.0 development version adds source-line warnings for hard-wrapped prose to `docket lint --json`. Keep paragraphs and simple list items on one source line and let the renderer wrap them. `docket lint --strict` exits nonzero on warnings as well as errors. Lint never rewrites source or rejects a browser save; use the reported path and line to review existing prose while preserving intentional Markdown breaks and structure.

## Local telemetry

Telemetry is local only and off by default. Enroll each checkout explicitly
with `docket telemetry enable`; `docket telemetry status` shows its state.
`docket telemetry report` summarizes observed operations, latency, errors, and
sampled runtime memory. Add `--json` for structured evidence.

`docket telemetry disable` stops collection. `docket telemetry delete` removes
the current checkout's enrollment and observations; exports remain user-owned.
Docket never uploads observations and excludes document contents, prompts,
search terms, task IDs, and file paths. Storage lives outside the repository.

Upgrade reports distinguish file operations from retained workflow differences. Human output labels retained differences `review`; JSON includes a `reviewRequired` path list and `reviewRequired: true` on those items. Compare these files with the current shipped workflow to distinguish intentional project requirements from stale instructions, including after resolving merge conflicts. An `up-to-date` action or current origin stamp does not establish content equivalence. Exit status remains nonzero for merge conflicts; review items preserve project-owned text and do not change the exit status.

## Workflow extensions (0.4.0 development)

Use `docket extension inspect|install|list|show|configure|enable|disable|remove|update|validate|reconcile|recover|refresh` for optional repository-owned workflow packages. [The extension guide](extensions.md) documents exact commands, authoring, tool recipes and evidence limits. Installation and validation never execute package content.
