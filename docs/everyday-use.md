# Use Docket day to day

Keep the scope of a change, its checks, and the decisions behind it beside your code. Your agent can read that context in the next session, and you can review the work through the Board, docs, and Git history.

The [one-task tutorial](getting-started.md) shows a simple example: a contributor guide records why links should work offline. A later session uses that decision when planning a troubleshooting guide.

## Choose how much tracking helps

For a small direct change:

> Fix the spelling in README. Keep this as a direct change.

For work whose scope and result you want to keep:

> Create a standalone Docket task to fix the broken installation link, with criteria that the replacement target exists and the example command is checked. Do not start it yet.

Review the task, then name its actual ID:

> Let's do HBR-1.

Replace HBR-1 with the ID returned by your agent. Naming the task tells the agent which work to start. Direct requests stay separate from your backlog.

## Capture wiki knowledge

> Create a wiki page about our cache architecture. Reuse an existing page if this is already documented; keep this as knowledge, without creating a task.

In the browser, open **Wiki → New page**. Enter a title, choose Reference, Spec or Playbook, check the suggested location, and write your content in the shared editor. Preview before saving. Save opens the new page and reports whether it was saved locally or committed. A collision keeps your draft so you can choose another location; Cancel confirms discarding a modified draft. New page drafts, including their type and location, can be recovered in the same browser tab after navigation or reload.

The `docket-wiki` workflow searches existing knowledge, chooses Reference, Spec or Playbook, and saves a linked page in the configured bundle. A later request such as “Update the cache reference to say keys expire after ten minutes” revises that page with a complete source version. A repeated unchanged request is a no-op. Describing a procedure does not run it or make it project guidance.

CLI-only example: run `docket search cache --json`, review any matches, then save this JSON as `page.json` outside the bundle:

```json
{"path":"reference/cache.md","type":"Reference","title":"Cache architecture","description":"How cache keys expire.","tags":["architecture"],"body":"# Cache architecture\n\nKeys expire after five minutes.\n"}
```

```sh
docket document create --input page.json --json
docket document read reference/cache.md --json
docket index
docket lint --json
```

For a revision, copy the complete `body` and `version` from the read result, revise the body, and save `{"expectedVersion":"<returned-version>","patch":{"body":"<complete-revised-body>"}}` as `edit.json`. Run `docket document edit reference/cache.md --input edit.json --json`, followed by index and lint. A duplicate path or stale version fails without replacing the newer source; reread and reconcile explicitly. MCP-only clients use `search`, `document_create`, `document_read`, `document_edit`, `index` and `lint` with the same fields. Native skills are generated for Claude, Codex and Cursor; restart an existing session if its skill inventory predates the upgrade.

## Reorganize a wiki page

> Move reference/nightly-import.md to reference/imports/nightly-import.md. Keep its title and content, inspect the move plan, repair incoming links and fragments, and preserve relative outbound targets. Report unmanaged references or recovery limitations. Do not start work, change guidance or commit.

The wiki workflow distinguishes path changes from title edits. It uses `docket document move-plan <from> <to> --json`, inspects affected files and warnings, then calls `document move-apply` with only the paths and returned version. Parsed Markdown links, images and reference definitions are repaired; code, labels and metadata stay intact. The derived index and subsequent search/navigation reflect the new path. References outside the bundle are not claimed repaired, and affected unsupported forms block the move for explicit reconciliation.

If a write fails, keep the receipt and use `docket document move-recover <token> --json`. The hidden journal under the bundle's `.docket-moves/` directory retains original and planned bytes. Recovery refuses unrelated edits; reconcile them explicitly instead of forcing an overwrite. Keep local journals until the move is verified and review before committing or archiving. [The CLI reference](cli.md#move-a-wiki-page) gives the exact request format; MCP exposes the same plan/apply/recover sequence.

## Record an accepted choice

> Record our decision to use nightly CSV imports instead of real-time events for initial customer onboarding. The upstream system already supplies nightly files; building an event feed would delay launch. Capture the alternatives, rationale and consequences, and link the existing import reference. Do not start tracked work or change guidance.

The `docket-task` workflow records the actual choice as an accepted Decision with Context, Decision and Consequences sections. Observations and reference material stay in ordinary wiki pages; saving a decision does not make it project guidance.

```sh
docket decision create --title "Use nightly CSV imports" --context "Considered nightly CSV and real-time events; the upstream system already supplies nightly files." --decision "Use nightly CSV for initial onboarding to avoid delaying launch." --consequences "Onboarding may wait until the next run; revisit events when an upstream feed exists." --json
docket index
docket lint --json
```

Read back the returned path with `docket document read <path> --json` and add relevant links through a complete versioned edit if needed. The default prefix is `DEC`, configurable with `ids.decision_prefix`; returned IDs are allocated safely across linked worktrees. MCP-only clients call `decision_create` with `title`, `context`, `decision`, `consequences` and optional `description`/`tags`, then `index` and `lint`. Existing task state and guidance remain unchanged.

## Find your bearings and resume

> Where did we leave off, and what's ready next?

The agent reads the project overview and follows relevant docs and Git history. Asking for status does not start a task. If your project has a written Home briefing, its review date helps you judge whether it needs an update:

> Refresh the project's re-entry note from repository evidence.

To pause tracked work, ask to stop the task for now. `docket task stop` clears the checkout’s active task while keeping its status. Resume by naming the same ID in this or a fresh session.

## Work on two tracked tasks at once

Several tasks may retain `in-progress` status, but each checkout has only one active task marker; neither status nor a marker proves an agent is running. If you explicitly want to hand the same checkout to another task, stop the current task and then start the named one. To have two tracked writers at once, give each a separate linked Git worktree on a distinct branch. A direct, untracked request does not make two writers sharing one checkout safe.

Starting a different task in an occupied checkout fails with `active-task-conflict`. The CLI names both IDs and suggests `git worktree add`, a starting point and an agent prompt. Check that the suggested commit contains the requested task and relevant guidance, and resolve any uncommitted task file, branch or path issue before using the recipe. The branch must follow your project's naming guidance. Later integration of the worktree branch is a separate step.

Paste this prompt into a second agent chat, replacing `<ID>` with the task you want it to start:

> Start Docket task `<ID>` while another task is active in this checkout. Preserve the original checkout and marker. Check project branch guidance and that the requested task and relevant guidance exist at a usable starting commit; flag uncommitted task files. Propose a separate linked worktree path, distinct branch, starting commit, and later integration step. Unless I've already explicitly authorized isolation for this request/session or through project guidance, ask me directly: “May I create a linked Git worktree at `<path>` on branch `<branch>` from commit `<commit>`, then start `<ID>` there?” Do not use a vague approval request or create it before I answer. Once authorized, tell me the chosen path and branch, run `git worktree add`, target all shell, file, and MCP operations at the new checkout, and run `docket task start <ID> --json` there. Do not stop the original task, integrate, or clean up without separate authorization.

The agent asks explicitly whether it may create the linked Git worktree before doing so by default. You can authorize this one worktree or all conflicts in a session in your request. To make automatic isolation a project preference, explicitly ask the agent to save this in existing project guidance: “For this project, when a requested Docket task conflicts with another active task, automatically create a separate linked worktree and start the requested task there. Leave the original checkout untouched and tell me which worktree and branch you use.” Ask it to remove that preference when you want confirmation again. A one-time approval does not save the preference; installation and upgrade do not enable it. Isolation authority covers only the new worktree and named pickup, not hand-off, integration or cleanup. A new Cursor window is optional if every command, edit and MCP connection reliably targets the new checkout.

### See progress in other worktrees

Docket reads saved task updates in linked worktrees on this computer, so progress can appear in your main view before the worker commits. Task and board rows show the source branch or checkout alongside recorded status. The expandable progress summary also lists tasks that exist only elsewhere. Epic views report observed child progress separately from recorded completion.

```sh
docket task progress
docket task progress TASK-42 --json
```

MCP clients use `task_progress`, optionally with an `id`. Task/ready reads flag observed progress and pickups. A task found only in another branch is read-only here; open that checkout to edit it. A pickup marker says someone picked up the task, not that an agent is running. These reads work equally with Codex, Claude Code, Cursor and ordinary CLI use.

“Done in branch · awaiting integration” means the branch reports completion but its integration has not been established here. Matching task status after a squash or cherry-pick alone does not prove the code was integrated, so that observation remains conservative. Dependencies still use this checkout's recorded task state. Conflicting changes stay visible; an old inherited status does not automatically win. No read copies task files, fetches or merges.

Saved changes are local to accessible worktrees. Committed branch versions remain observable when a checkout is absent; remote-tracking refs reflect the last explicit fetch. Long-lived readers use a two-second evidence cache, and the browser refreshes through periodic reconciliation. Source, file and time limits or unreadable worktrees appear as partial evidence; the absence of an observation is not an exclusive ownership guarantee.

## Reuse docs; add structure when it helps

Keep useful existing docs where they are, and link tasks to the relevant context. Documents in the bundle use `type` frontmatter and ordinary Markdown links. You can bring existing documents into the bundle gradually.

Use an epic when several tasks contribute to one outcome, and a spec when you need to describe expected behavior in more detail. A standalone task is often enough.

> Create a Welcome guide epic with two dependent tasks: write the guide, then link it from README. Give each task concrete checks. Do not start it yet.

After reviewing the scope, name the returned epic ID and ask the agent to complete it. The [epic guide](epics.md) explains the process. Dependent tasks become ready when all their prerequisites are done.

## Review and finish work

Review the task’s acceptance criteria, checks, Outcome, changed docs, and Git commits. The close workflow asks your agent to update affected documentation and explain the result.

Done means the criteria were completed. Closed means the work was intentionally discontinued with a recorded reason; it does not satisfy dependencies. Done stays final. Closed stays final by default, but projects can enable reopening for Tasks or Epics with `workflow.reopen_closed: [Task, Epic]`; reopening requires a reason and preserves the earlier disposition. For follow-up work, create a linked item:

> Create a follow-up task linked to HBR-1 for the remaining keyboard issue. Keep it unstarted and record a concrete acceptance check.

## Save project instructions

Ask your agent to remember conventions or procedures you want it to use again:

> Remember this project convention: contributor instructions should use short imperative sentences. Apply it when writing contributor-facing docs.

> Show the saved project guidance and where each instruction comes from.

> Revise the saved contributor-writing convention: prefer short imperative sentences, but include an explanation when a step needs context.

> Save our existing release checklist as a project procedure. Apply it only when I explicitly request a release; saving the link does not authorize running it.

> Retire the contributor-writing convention. Preserve the shared source and record why: it is no longer a project requirement.

Guidance lives in `docket/reference/project-guidance.md` and can link to existing instructions. Review the saved text and its scope. Saving a procedure makes it available for later use; ask separately when you want it carried out.

After changing guidance, ask an ongoing agent to reread it or open a fresh session. A save does not update instructions the agent has already read. If requirements conflict or a linked source is missing, resolve that issue before using the affected instructions.

Docket’s supplied workflows describe how to create, start, and close tasks. Project guidance records your own working conventions. Both are editable Markdown. [Workflow extensions](extensions.md) let you share a larger team process; the [guidance example](../examples/guidance/README.md) shows a small set of saved instructions.

## Edit docs in the browser

Run `docket serve`, open Wiki/Docs or Project guidance, and choose an authored page. Select Edit, change the title, description, or Markdown body, then Preview and Save. Your agent and editor can work with the same source file.

Save writes local, uncommitted files. Review `git diff` and commit when ready. Start Serve with `--commit` if you want a commit for each operation. If you see “Saved locally; commit failed,” the file was saved: inspect Git status and resolve the commit problem before retrying.

When another edit changes the source, the editor keeps your draft and shows a conflict. Review the latest text, reconcile your changes, and retry. Same-tab draft recovery after navigation or reload is best-effort; copy important unsaved work before closing the tab.

Tasks, epics, specs, references, decisions, playbooks, workflows, and custom concepts share this editor. Generated indexes and Git history are read-only; introductions, briefings, and logs use their own workflows. Use task commands to change status or identity. Editing an acceptance checkbox does not change task status. The editor supports Markdown documents up to 262,144 bytes.

## Keep knowledge current

Closing a task updates the docs affected by that change. You can also ask for a wider review:

> Review documentation freshness since the last watermark and reconcile drift supported by the commits.

> Audit the backlog for stale or inconsistent work and propose fixes before changing it.

> Refresh the project re-entry note from current repository evidence.

These requests serve different purposes: finding doc drift, reviewing work state, and updating the project summary. Use `docket index` after direct source edits to refresh generated views, and `docket lint` to check structure and links.

## Customize and upgrade workflows

Edit supplied workflow Markdown to fit your project, and commit your changes. After updating GitDocket, run `docket upgrade --dry-run` to preview instruction updates, then `docket upgrade` to apply them. Review the resulting text and resolve any conflicts with your customizations.

Installed [workflow extensions](extensions.md) have their own update commands and project choices.
