# CLI reference

GitDocket’s CLI is intentionally small. Use `--json` when another program or coding agent consumes a command.

| Command | Purpose |
| --- | --- |
| `docket init` | Adopt a repository additively and finish its first index/cache pass. |
| `docket overview` | Read the current project briefing, in-flight work, and next frontier. |
| `docket ready` | List tasks whose stored state and dependencies make them ready. |
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
