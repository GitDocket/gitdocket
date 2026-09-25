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
| `docket task create` | Create a Task or Epic with the next project ID. |
| `docket decision create` | Record an accepted Decision with the configured decision prefix. |
| `docket task start <ID>` | Start or resume explicitly selected tracked work; refuse a different ID when this checkout is occupied. |
| `docket task stop` | Clear the checkout-local active task without changing its status. |
| `docket task close <ID>` | Move completed work to `done`, or explicitly close without completion. |
| `docket lint` | Report schema, link, and workflow-hygiene problems. |
| `docket index` | Regenerate the committed index and rebuild the local cache. |
| `docket verify status` | Derive spec-to-test presence from source markers. |
| `docket upgrade` | Three-way merge newer vendored workflows and regenerate adapters. |
| `docket serve` | Open the local-only browser interface. |

Run `docket <command> --help` for flags and exact argument forms.

## Parallel tracked work

`in-progress` is stored task status; it does not mean an agent is running. Each checkout has one `.docket/active-task` marker. Starting the same ID resumes it. An explicitly authorized hand-off runs `docket task stop` and then `docket task start <ID> --json` in the same checkout. Two concurrent tracked writers use separate linked Git worktrees and distinct branches. Untracked direct work does not make simultaneous editing in one checkout safe.

When `docket task start <ID> --json` encounters another active ID, it exits nonzero with `error.code: "active-task-conflict"`. The response names `activeTaskId` and `requestedTaskId`, offers an explicitly authorized `handoff`, and includes an `isolation` path, branch, starting point, `git worktree add` recipe, issues and agent prompt. An unresolved task file or starting point makes `isolation.command` null; resolve it before creating a worktree. Adapt the branch to project naming guidance. The agent must also ensure the starting commit contains the requested task and relevant guidance, and plan for later integration.

Paste this prompt into a second agent chat, replacing `<ID>` with the task you want it to start:

> Start Docket task `<ID>` while another task is active in this checkout. Preserve the original checkout and marker. Check project branch guidance and that the requested task and relevant guidance exist at a usable starting commit; flag uncommitted task files. Propose a separate linked worktree path, distinct branch, starting commit, and later integration step. Unless I've already explicitly authorized isolation for this request/session or through project guidance, ask me directly: “May I create a linked Git worktree at `<path>` on branch `<branch>` from commit `<commit>`, then start `<ID>` there?” Do not use a vague approval request or create it before I answer. Once authorized, tell me the chosen path and branch, run `git worktree add`, target all shell, file, and MCP operations at the new checkout, and run `docket task start <ID> --json` there. Do not stop the original task, integrate, or clean up without separate authorization.

An explicit question about creating the linked Git worktree is the default. An explicit request can authorize one isolation or a session's conflicts. You may also ask the agent to save this preference in existing project guidance: “For this project, when a requested Docket task conflicts with another active task, automatically create a separate linked worktree and start the requested task there. Leave the original checkout untouched and tell me which worktree and branch you use.” Ask it to remove the preference to return to confirmation. A one-time approval does not save it, and installation or upgrade never enables it. This authority covers isolation and named pickup only; hand-off, integration and cleanup need separate authorization. All operations, including MCP calls, must target the new checkout; changing shell directory does not retarget an existing MCP server.

`docket lint --json` reports source-line warnings for hard-wrapped prose. Keep paragraphs and simple list items on one source line and let the renderer wrap them. `docket lint --strict` exits nonzero on warnings as well as errors. Lint never rewrites source or rejects a browser save; use the reported path and line to review existing prose while preserving intentional Markdown breaks and structure.

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


## Ordinary wiki documents

`docket document create --input <json-file> --json` exclusively creates an ordinary Reference, Spec or Playbook. The JSON contains `path` (relative to the configured bundle), `type`, `title`, `body`, and optional `description` and `tags`. Paths must end in `.md`; reserved pages, guidance, tracked-work, workflow, decision and extension locations are excluded. The engine adds a timestamp and rejects existing paths without overwriting them.

`docket document read <path> --json` returns a complete editable body, title, description and source version. `docket document edit <path> --input <json-file> --json` accepts `{expectedVersion, patch}`; the patch can change only body/title/description. A stale source version conflicts. Run `docket index` and `docket lint --json` after authoring. See the [complete wiki example](everyday-use.md#capture-wiki-knowledge).


## Record a decision

`docket decision create --title "…" --context "Context and alternatives" --decision "Accepted choice and rationale" --consequences "Tradeoffs" --json` writes a Decision under `decisions/` with a timestamp and `status: accepted`. Optional `--description` and `--tags` supply metadata. Omitted body sections receive placeholders; complete them before treating the record as finished. The result contains `id` and `path`. Run `docket index` and `docket lint --json` afterward.

The ID prefix is `ids.decision_prefix` in `docket.yaml` (default `DEC`); its sequence is independent of project work IDs when the prefixes differ. Identical prefixes share occupied IDs and aliases. Linked Git worktrees coordinate both creation commands through one allocation lock, and occupied destinations are never overwritten. `task create --type` accepts only Task or Epic. Decision recording does not start or stop tracked work, change its active marker, or select project guidance. See the [decision example](everyday-use.md#record-an-accepted-choice).


## Move a wiki page

Use `docket document move-plan <from> <to> --json` with bundle-relative paths for an ordinary Reference, Spec or Playbook. Inspect `paths`, `replacements`, `blockers` and `warnings`. Save `{"from":"reference/old.md","to":"reference/topic/new.md","expectedVersion":"<plan.version>"}` as a JSON file, then run `docket document move-apply --input move.json --json`. A title-only change uses `document edit` and keeps the path. Case-only, protected/owned or occupied destinations are refused.

The engine repairs parsed inline/image/reference-definition destinations, preserves fragments, rebases relative outbound links and refreshes the index. Labels, code and metadata remain unchanged. A changed bundle snapshot, including a new incoming reference, invalidates the plan. Affected HTML/frontmatter/owned links require explicit reconciliation; code, non-Markdown and outside references are unmanaged. Check the new page, search and `docket lint --json` after completion.

A partial failure returns `state: recovery_required` and exits nonzero. Keep its token and run `docket document move-recover <token> --json`. Original and planned bytes remain in `<bundle>/.docket-moves/<token>.json`; recovery validates the journal and refuses unrelated changes. Treat journals as local recovery material, retain until verified and review before committing or archiving. These commands never commit, start work or select guidance. See the [everyday example](everyday-use.md#reorganize-a-wiki-page).

## Task progress across worktrees

`docket task progress [ID] --json` reads a bounded combined view of saved task files in linked worktrees and pinned versions in locally available refs. Omit `--json` for source-labelled human output. The result includes observation time, coverage diagnostics, conflicts, pickup markers and integration evidence. Tasks existing only elsewhere have `localStatus: null`; their observations do not create editable local tasks. `task list` and `ready` preserve recorded status and canonical ordering while adding relevant progress flags. Use `task progress` to discover foreign-only tasks or inspect partial coverage. The [everyday guide](everyday-use.md#see-progress-in-other-worktrees) explains refresh and integration behavior.
