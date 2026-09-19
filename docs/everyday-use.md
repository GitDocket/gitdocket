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

## Find your bearings and resume

> Where did we leave off, and what's ready next?

The agent reads the project overview and follows relevant docs and Git history. Asking for status does not start a task. If your project has a written Home briefing, its review date helps you judge whether it needs an update:

> Refresh the project's re-entry note from repository evidence.

To pause tracked work, ask to stop the task for now. `docket task stop` clears the checkout’s active task while keeping its status. Resume by naming the same ID in this or a fresh session.

## Reuse docs; add structure when it helps

Keep useful existing docs where they are, and link tasks to the relevant context. Documents in the bundle use `type` frontmatter and ordinary Markdown links. You can bring existing documents into the bundle gradually.

Use an epic when several tasks contribute to one outcome, and a spec when you need to describe expected behavior in more detail. A standalone task is often enough.

> Create a Welcome guide epic with two dependent tasks: write the guide, then link it from README. Give each task concrete checks. Do not start it yet.

After reviewing the scope, name the returned epic ID and ask the agent to complete it. The [epic guide](epics.md) explains the process. Dependent tasks become ready when all their prerequisites are done.

## Review and finish work

Review the task’s acceptance criteria, checks, Outcome, changed docs, and Git commits. The close workflow asks your agent to update affected documentation and explain the result.

Done means the criteria were completed. Closed means the work was intentionally discontinued with a recorded reason; it does not satisfy dependencies. Both states are final. For more work, create a linked follow-up:

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
