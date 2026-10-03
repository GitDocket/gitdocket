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
| `docket task start <ID>` | Start or resume a named Task, or return a non-mutating Epic supervision route; refuse a different Task ID when this checkout is occupied. |
| `docket task stop [ID] --json` | Clear matching checkout lifecycle state without changing status; optional workflow-token and closure-commit guards. |
| `docket task close <ID>` | Move completed work to `done`, or explicitly close without completion. |
| `docket lint` | Report schema, link, and workflow-hygiene problems. |
| `docket index` | Refresh discovery and reuse the local cache only when freshly derived inputs and its bytes match. |
| `docket verify status` | Derive spec-to-test presence from source markers. |
| `docket upgrade` | Three-way merge newer vendored workflows and regenerate adapters. |
| `docket serve` | Open the local-only browser interface. |

Run `docket <command> --help` for flags and exact argument forms.

For a named Task, `docket task start <ID> --json` moves it to `in-progress`, sets the checkout-local active task and returns a context packet. For a named Epic, the same command succeeds with `outcome: "route"`, a `docket-epic` workflow target, authoritative Epic content and the exact `Epic <ID> — <title>` manager title. The route does not change status, write or clear the active-task marker, or select a child; epic supervision owns the subsequent graph, readiness and checkout-conflict judgment.

In the 0.6.2 development candidate, add `--compact` for the opt-in `docket-pickup/v1` Task packet or `docket-epic-route/v1` route, limited to 32 KiB of two-space-indented UTF-8 JSON (plus the CLI newline). The legacy full packet remains the default. Compact pickup retains canonical identity, source version, lifecycle outcome/token, dependency totals and non-done/unresolved counts, drift and instruction authority. Body/title previews and selected links/commits disclose omissions. `contextComplete: false` and `requiredReads` identify omitted required source; follow `source`/`source_page` cursors before implementation. Guidance stays included when it fits; its required continuation starts at the next page. Reuse an exact retained source/version when applicable instead of repeating pickup. An omitted title intent skips the optional host rename. Pickup does not establish dependency readiness, acceptance or integration.

## Parallel tracked work

`in-progress` is stored task status; it does not mean an agent is running. Each checkout has one `.docket/active-task` marker. Starting the same ID resumes it. An explicitly authorized hand-off runs `docket task stop` and then `docket task start <ID> --json` in the same checkout. Two concurrent tracked writers use separate linked Git worktrees and distinct branches. Untracked direct work does not make simultaneous editing in one checkout safe.

When `docket task start <ID> --json` encounters another active ID, it exits nonzero with `error.code: "active-task-conflict"`. The response names `activeTaskId` and `requestedTaskId`, offers an explicitly authorized `handoff`, and includes an `isolation` path, branch, starting point, `git worktree add` recipe, issues and agent prompt. An unresolved task file or starting point makes `isolation.command` null; resolve it before creating a worktree. Adapt the branch to project naming guidance. The agent must also ensure the starting commit contains the requested task and relevant guidance, and plan for later integration.

Paste this prompt into a second agent chat, replacing `<ID>` with the task you want it to start:

> Start Docket task `<ID>` alongside the current work. Check existing authority before asking for approval, preserve the original checkout and task marker, and use a separate working copy when authorized. Check overlapping edits separately and continue independent ready work. Lead with the recommended next action; include the checkout, branch and starting commit as supporting details.

The agent checks existing authority before asking for worktree approval. Applicable host instructions can authorize routine reversible isolation within your requested scope; you can also authorize one worktree or a session's conflicts directly. A lower-priority confirmation default adds no new gate. To save an automatic-isolation preference, explicitly ask the agent to record it in existing project guidance: “For this project, when a requested Docket task conflicts with another active task, automatically create a separate linked worktree and start the requested task there. Leave the original checkout untouched and tell me which worktree and branch you use.” Ask it to remove that preference when you want confirmation again. A one-time approval does not save it; installation and upgrade do not enable it. Isolation authority covers the new worktree and named pickup only. All operations, including MCP calls, must target the new checkout; changing shell directory does not retarget an existing MCP server.

A separate working copy protects files but does not settle two chats editing the same page. Establish a current baseline and one agreed writer or a reconciliation plan for affected edits. If one epic child must wait, the agent checks the current ready list and continues independent authorized work in an authorized checkout. For example, an independent reference-page pilot can proceed while another chat finishes editing the active-work pilot page.

For a documentation cleanup, the next action can be stated simply: “I recommend doing the cleanup in a separate working copy so the current feature work can continue. I’ll start with the independent reference page and defer the shared pilot page until its ongoing edits are settled. You’ll review both pilots before broader cleanup.” If isolation authority is missing, add one direct question about creating that working copy, followed by the concrete path, branch, starting commit and named task. Explain any required approval source once; later status replies should state the next action.

`docket lint --json` reports source-line warnings for hard-wrapped prose. Keep paragraphs and simple list items on one source line and let the renderer wrap them. `docket lint --strict` exits nonzero on warnings as well as errors. Lint never rewrites source or rejects a browser save; use the reported path and line to review existing prose while preserving intentional Markdown breaks and structure.

## Local telemetry

Telemetry is local only and off by default. Enroll each checkout explicitly
with `docket telemetry enable`; `docket telemetry status` shows its state.
`docket telemetry report` summarizes observed operations, latency, errors, and
sampled runtime memory. Add `--json` for structured evidence.

In the 0.6.2 development candidate, `docket telemetry report --trace <supplied-file> --context --json` returns a separate `docket-context-volume/v1` review limited to 8 KiB of two-space-indented UTF-8 JSON. It examines only the supplied bounded export, without querying a host or the event store. It separates exported output representations, explicitly caller-measured response bytes, advertised schemas/instructions, supplied host-loaded material and optional host observations; absent dimensions are unavailable. Largest contributions, repeated same-resource reads and recorded compaction windows carry ordinal evidence and omitted counts. Optional `docketContext` annotations on matched call items can supply exact-source or lint-input versions and supported observations. Bytes and repetition do not establish waste, token occupancy or degraded reasoning. Omit `--context` for the complete existing trace-review view; source pages remain exact paginated UTF-16-unit reads rather than an 8 KiB byte promise.

Caller annotations use `schema: docket-context-observation/v1`. Optional `sourceVersion` and `lintInputVersion` are exact lowercase 64-character SHA-256 strings. Optional `responseBytes`, `advertisedSchemaBytes`, `advertisedInstructionBytes`, `advertisedToolCount` and `hostLoadedBytes` are nonnegative integer counts up to one billion. `host` accepts `provenance` (host-reported or caller-estimate), `kind` (current-context or cumulative-usage), `model` (gpt-6, gpt-5, claude, gemini, other or unknown), ISO `observedAt`, integer `tokens`, positive `windowTokens` or null, and boolean `partial`. Unknown fields invalidate the annotation. The review reports invalid counts without retaining their content.

A current-window percentage applies only at the supplied observation time, with host-reported current-context provenance, nonpartial coverage and a consistent denominator. Cumulative usage, caller estimates and missing/inconsistent windows remain separate; no host verification or universal overload threshold is supplied. Source-version equality is caller evidence, not proof a reread was unnecessary. Annotations stay in the caller-owned explicit export and do not add stored telemetry fields.


`docket telemetry disable` stops collection. `docket telemetry delete` removes
the current checkout's enrollment and observations; exports remain user-owned.
Docket never uploads observations and excludes document contents, prompts,
search terms, task IDs, and file paths. Storage lives outside the repository.

Upgrade reports distinguish file operations from retained workflow differences. Human output labels retained differences `review`; JSON includes a `reviewRequired` path list and `reviewRequired: true` on those items. Compare these files with the current shipped workflow to distinguish intentional project requirements from stale instructions, including after resolving merge conflicts. An `up-to-date` action or current origin stamp does not establish content equivalence. Exit status remains nonzero for merge conflicts; review items preserve project-owned text and do not change the exit status.

## Workflow extensions

Use `docket extension inspect|install|list|show|configure|enable|disable|remove|update|validate|reconcile|recover|refresh` for optional repository-owned workflow packages. [The extension guide](extensions.md) documents exact commands, authoring, tool recipes and evidence limits. Installation and validation never execute package content.

## Agent overview (0.6.2 development)

`docket overview --json` returns `agent-overview/v1`: live next-ready work, selected workstreams and standalone tasks, recent completions, attention items, a dated context excerpt and Git highlights. Collections report total and omitted counts. The default JSON is limited to 16 KiB of two-space-indented UTF-8 JSON; `budget` records additional record omissions and context-excerpt reduction. Canonical next-work identity and coordination warnings remain intact. Exceptional authority material that cannot fit is refused with the explicit full-view route. Follow an item's source path when you need detail.

Use `docket overview --json --full` for the previous JSON model and for refreshing the written project briefing. Scripts that read the old default fields must add `--full`. The human `docket overview` output is unchanged. The bounded response does not remove the cost of reading project metadata and Git evidence.


## Ordinary wiki documents

`docket document create --input <json-file> --json` exclusively creates an ordinary Reference, Spec or Playbook. The JSON contains `path` (relative to the configured bundle), `type`, `title`, `body`, and optional `description` and `tags`. Paths must end in `.md`; reserved pages, guidance, tracked-work, workflow, decision and extension locations are excluded. The engine adds a timestamp and rejects existing paths without overwriting them.

`docket document read <path> --json` returns a complete editable body, title, description and source version. `docket document edit <path> --input <json-file> --json` accepts `{expectedVersion, patch}`; the patch can change only body/title/description. A stale source version conflicts. Run `docket index` and `docket lint --json` after the final authoring batch. See the [complete wiki example](everyday-use.md#capture-wiki-knowledge).


## Record a decision

`docket decision create --title "…" --context "Context and alternatives" --decision "Accepted choice and rationale" --consequences "Tradeoffs" --json` writes a Decision under `decisions/` with a timestamp and `status: accepted`. Optional `--description` and `--tags` supply metadata. Omitted body sections receive placeholders; complete them before treating the record as finished. The result contains `id` and `path`. Run `docket index` and `docket lint --json` afterward.

The ID prefix is `ids.decision_prefix` in `docket.yaml` (default `DEC`); its sequence is independent of project work IDs when the prefixes differ. Identical prefixes share occupied IDs and aliases. Linked Git worktrees coordinate both creation commands through one allocation lock, and occupied destinations are never overwritten. `task create --type` accepts only Task or Epic. Decision recording does not start or stop tracked work, change its active marker, or select project guidance. See the [decision example](everyday-use.md#record-an-accepted-choice).


## Move a wiki page

Use `docket document move-plan <from> <to> --json` with bundle-relative paths for an ordinary Reference, Spec or Playbook. Inspect `paths`, `replacements`, `blockers` and `warnings`. Save `{"from":"reference/old.md","to":"reference/topic/new.md","expectedVersion":"<plan.version>"}` as a JSON file, then run `docket document move-apply --input move.json --json`. A title-only change uses `document edit` and keeps the path. Case-only, protected/owned or occupied destinations are refused.

The engine repairs parsed inline/image/reference-definition destinations, preserves fragments, rebases relative outbound links and refreshes the index. Labels, code and metadata remain unchanged. A changed bundle snapshot, including a new incoming reference, invalidates the plan. Affected HTML/frontmatter/owned links require explicit reconciliation; code, non-Markdown and outside references are unmanaged. Check the new page, search and `docket lint --json` after completion.

A partial failure returns `state: recovery_required` and exits nonzero. Keep its token and run `docket document move-recover <token> --json`. Original and planned bytes remain in `<bundle>/.docket-moves/<token>.json`; recovery validates the journal and refuses unrelated changes. Treat journals as local recovery material, retain until verified and review before committing or archiving. These commands never commit, start work or select guidance. See the [everyday example](everyday-use.md#reorganize-a-wiki-page).

## Task progress across worktrees

`docket task progress [ID] --json` reads a bounded combined view of saved task files in linked worktrees and pinned versions in locally available refs. Omit `--json` for source-labelled human output. The result includes observation time, coverage diagnostics, conflicts, pickup markers and integration evidence. Tasks existing only elsewhere have `localStatus: null`; their observations do not create editable local tasks. `task list` and `ready` preserve recorded status and canonical ordering while adding relevant progress flags. Use `task progress` to discover foreign-only tasks or inspect partial coverage. The [everyday guide](everyday-use.md#see-progress-in-other-worktrees) explains refresh and integration behavior.

## Closure cleanup

In the 0.6.2 candidate, prepare the Outcome or Disposition and reconcile docs before `task close`. The result retains lifecycle state for the task-trailer hook and returns `closure.cleanup.args` when that task is active. Finish discovery, validation and the task-linked closure commit, then run those arguments with the actual commit hash substituted for `<closure-commit-sha>`. `task stop <ID> --workflow-token <token> --after-commit <sha> --json` refuses another Task, a different pickup token, a nonterminal or changed Task source, a missing task trailer, or a commit outside HEAD's ancestry. It does not test acceptance criteria or infer integration.

Named stop without `--after-commit` also supports authorized pauses and serialized handoffs. Retain the pickup's `telemetryWorkflow` token to distinguish a newer pickup of the same Task. ID-only cleanup provides a weaker Task guard; bare stop remains compatible for explicitly authorized checkout-wide cleanup. Both share the current engine's pickup lock. External and older clients must cooperate; this is not an OS-level compare-and-swap guarantee.

JSON reports `cleanup.disposition`, actual cleared paths, mutation disposition and `statusChanged: false`. Results distinguish `cleared`, `no-active-marker`, `already-clear`, marker/workflow mismatch, orphan tokens, unavailable state and interrupted cleanup. `already-clear` describes present empty state without proving earlier cleanup history. An unknown orphan token is preserved; an exact retained token can finish interrupted associated-token cleanup. A filesystem error after verified full removal reports `cleared-with-error` and applied state; no repeat cleanup is needed. Nonzero results carry state and recovery information without automatically clearing another writer. MCP has no task start, close or stop binding; use the matching CLI checkout for lifecycle operations.

## Focused lint evidence

The 0.6.2 candidate keeps `docket lint --json` as the complete diagnostic array and adds stable `code`, `category` and evidence fingerprints. Use `docket lint --summary --json --report .docket/lint/<owned-file>.json` after the final batch for an 8 KiB summary and a complete saved report. The owned destination must be JSON; an existing destination must already be a complete Docket lint report. Add `--baseline <prior-report>` to compare warning history and repeat `--changed-path <exact-path>` for relevant warnings. Global errors and introduced findings remain selected. `--strict` still fails on every global warning, including hidden warnings; selection changes presentation only. `--limit` accepts 1–32 details and `--offset` follows the returned continuation. A complete saved report is limited to 8 MiB and 20,000 source/diagnostic rows; the full array remains available for larger inputs.

Baseline comparison requires matching checkout, configuration and rules. Checks with different observation coverage remain unknown while compatible source findings still compare. Missing, incomplete, tampered or incompatible reports never imply a clean change. Comparison matches diagnostic-signature occurrences; identical occurrences have no individual historical identity. Prose identity survives source-line movement, unique identical-content relocation is explicit, and ambiguous relocation remains unknown. Counts distinguish pre-existing, introduced, resolved and unknown findings. Input hashes describe the captured inputs; verify applicability before reusing validation after later source, rule, configuration, Git or time changes.

`docket index --json` reports index/cache changes and actual scan, build and publication counts. Every CLI refresh observes the complete current bundle, configured verification markers and canonical HEAD activity; unchanged index bytes alone do not authorize cache reuse. Reuse requires matching derived-input and cache-byte hashes in the checkout-local receipt. Missing/unreadable receipts, altered cache bytes or unavailable Git force rebuilding; an interrupted publication leaves mismatched evidence that the next invocation rebuilds. The cache is derived and disposable. It represents the observed inputs, with no guarantee against later external changes. Git refs outside HEAD do not affect this cache's canonical activity; cross-worktree evidence uses separate observers. `--rebuild` forces a complete cache rebuild. `--check` checks only index freshness and writes nothing; combining it with `--rebuild` is invalid. Normal unchanged refreshes preserve prior verification-result rows; rebuilding still clears them. Cached files above 256 MiB cannot be verified by this bounded reuse path and require explicit investigation rather than an unchanged claim.

MCP `index` refreshes Markdown discovery only and keeps returning a source version and changed/no-op result. It does not rebuild or verify the CLI's SQLite cache. MCP clients that need CLI cache publication use the CLI in the intended checkout.

Compact item writes include `discovery` pending-work hints alongside their source paths and version. They identify whether index assessment remains and confirm that the engine did not write the bundle log or parent epic. Under an explicit prepared-worker/integrator contract, workers retain task-local criteria, Outcome/pending acceptance and dated Log evidence; the integrator consolidates eligible shared updates once after review. Required local discovery and validation still apply, and nonterminal handoffs do not unblock dependencies. Ordinary standalone closure retains its full sequence. Required multi-source wiki move/reconciliation repairs remain engine-owned exceptions.
