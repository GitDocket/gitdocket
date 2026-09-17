# Use Docket day to day

Read context → choose a change → implement and verify → update the project's knowledge → use that knowledge again. Docket keeps docs, tasks and working instructions in your repository so your coding agent can resume with less re-explanation and you can inspect what changed, why and what was checked.

The [one-task tutorial](getting-started.md) records an offline documentation decision while adding a contributor guide. A later session can find that decision and recommend relative links for a troubleshooting guide. That is useful continuity, even if there is no next task or authored briefing.

## Choose how much tracking helps

Use direct requests for small work that does not need a tracked receipt:

> Fix the spelling in README. Keep this as a direct change.

For work whose scope, checks and outcome should be retained:

> Create a standalone Docket task to fix the broken installation link, with criteria that the replacement target exists and the example command is checked. Do not start it yet.

Then use the actual ID returned by the agent:

> Let's do HBR-1.

Replace HBR-1 with your project's real ID. Naming the item authorizes pickup; a generic request to implement something does not choose unrelated backlog work. Docket's engine assigns IDs, enforces status changes and derives readiness. Your coding agent performs implementation, verification and documentation reconciliation using the checked-in workflows. Review its evidence rather than assuming a done status proves correctness.

## Find your bearings and resume

> Where did we leave off, and what's ready next?

This is read-only orientation. The agent starts with `docket overview --json` and follows relevant docs or Git evidence as needed. It does not start work or regenerate the index just to answer. An absent Home briefing is valid; task files and Git still show current work. An old briefing remains readable with its review date. To update that authored summary explicitly:

> Refresh the project's re-entry note from repository evidence.

To pause an active tracked task, ask to stop that task for now. `docket task stop` clears the checkout's active marker and keeps the stored status. Resume by naming the same ID; do not create a duplicate. Starting a fresh session does not itself refresh a briefing or select work.

## Reuse docs; add structure when it helps

Keep useful existing docs where they are. Link tasks to relevant context. Init leaves existing Markdown untouched and may suggest metadata for you to review; not every existing document needs to be adopted before one task can succeed. Bundle docs use `type` frontmatter and ordinary Markdown links.

A task can stand alone. Use an epic when several tasks contribute to a larger outcome, and a spec when writing down intent or expected behavior helps the work. Neither is required. Lint checks broken explicit links and invalid dependencies; 0.3.0 also removes the absence-only warning for epics without specs. Earlier installed workflows may still recommend more hierarchy.

> Create a Welcome guide epic with two dependent tasks: write the guide, then link it from README. Give each task concrete checks. Do not start it yet.

After reviewing the scope, name the returned epic ID and ask to run it through completion. The [epic follow-on](epics.md) explains the loop. Dependent tasks become ready only after their prerequisites are done; an unfinished or discontinued dependency remains blocking.

## Inspect and finish work

Review the task's acceptance criteria, Outcome, check results, changed docs and task-linked Git commits. The agent's close workflow reconciles affected project knowledge and records what shipped. The engine's close command changes state and logs the conclusion; it does not perform the agent's verification or editorial judgment.

Done means the criteria were completed. Closed means the work was intentionally discontinued with a recorded reason; it does not satisfy dependencies. Both states are terminal. More work belongs in a new task linked to the old one:

> Create a follow-up task linked to HBR-1 for the remaining keyboard issue. Keep it unstarted and record a concrete acceptance check.

A clean one-task project may have no pending work. A completion receipt should say so. Do not create tasks just to fill the Board.

## Save how this project works (optional)

**Available in 0.3.0:** project guidance and the shared browser editor below are included in 0.3.0. Upgrade older installations before using these optional examples. Native adapter files are tested; fresh native Codex/Claude runtime qualification remains limited by the client/model and authentication failures recorded in feature verification. Controlled agent checks are not a guarantee of model compliance.

Use guidance for chosen working instructions, distinct from descriptive docs and task history. It lives in `docket/reference/project-guidance.md`, with scoped links to existing procedure sources. These are supported prompts:

> Remember this project convention: contributor instructions should use short imperative sentences. Apply it when writing contributor-facing docs.

> Show the saved project guidance and where each instruction comes from.

> Revise the saved contributor-writing convention: prefer short imperative sentences, but include an explanation when a step needs context.

> Save our existing release checklist as a project procedure. Apply it only when I explicitly request a release; saving the link does not authorize running it.

> Retire the contributor-writing convention. Preserve the shared source and record why: it is no longer a project requirement.

Inspect the saved source after authoring. The agent should reuse an existing authoritative source rather than create competing instructions. General standards apply within their authored scope; a procedure link does not authorize deployment or other execution. Agents read relevant guidance before direct or tracked implementation and reread after explicit changes or before starting the next piece of work. A save does not instantly alter an already-running session. Broken required sources or contradictory standards should be surfaced, not silently weakened.

Docket's supplied tracker workflows tell the agent how to create, pick up, groom and close work. Project guidance tells it how your project expects work to be done. Both are editable Markdown. The [0.4.0 preview adds workflow extensions](extensions.md) for sharing a team process. A [synthetic guidance example](../examples/guidance/README.md) shows the source structure; the beginner tutorial needs none of this setup.

## Inspect and edit saved project knowledge

In a build with shared editing, run `docket serve`, open Wiki/Docs or Project guidance, and read the source. On an authored page, choose Edit, change the title, description or Markdown body, Preview, and Save. Project guidance also offers instruction and scoped procedure-link management using that same editor. You can instead ask your agent to edit the same file; there is one source of truth.

Default Save writes local, uncommitted files. Review `git diff` and commit when appropriate. Starting Serve with `--commit` requests a commit per operation. “Saved locally; commit failed” means the source change succeeded and the Git step failed; inspect Git status and fix the commit problem without blindly repeating the edit.

If another edit changes the source version, the editor keeps your draft and shows the conflict. Copy the draft if needed, review the latest source, reconcile the text, and retry against that version. Same-tab draft recovery after navigation/reload is best-effort; closing the tab, clearing storage, a crash or storage limits can lose it. There is no force-save shortcut around conflict review.

Ordinary authored tasks, epics, specs, references, decisions, playbooks, workflows and custom concepts share this editor. Derived indexes, rollups and Git history are read-only; project introductions, briefings and logs retain their specific workflows. IDs, lifecycle state, timestamps and evidence stamps are not body-editor fields. Changing acceptance-checkbox text does not change task status or assert that the checks ran. The editor handles Markdown up to 262,144 bytes, not rich text or arbitrary frontmatter.

## Maintain knowledge for a purpose

Close-time reconciliation updates docs affected by one completed task. A freshness review looks back over commits since its watermark for drift missed during close, including useful knowledge from direct work. A briefing refresh updates the authored re-entry summary. They are distinct opt-in activities:

> Review documentation freshness since the last watermark and reconcile drift supported by the commits.

> Audit the backlog for stale or inconsistent work and propose fixes before changing it.

> Refresh the project re-entry note from current repository evidence.

Use `docket index` after direct source edits to refresh generated views. Lint diagnoses structural problems and selected hygiene issues; an ordinary status question does not need a full backlog audit.

## Keep customization reviewable

You can edit supplied workflow Markdown today. `docket upgrade --dry-run` previews the existing upgrade path, and `docket upgrade` uses versioned three-way merges while regenerating generated sections of agent instructions. Review actual text and resolve conflicts before using the changed procedures. Same-origin local differences may be retained rather than updated; an origin stamp alone cannot prove that you have the latest workflow body. Commit your customizations so their intent and recovery are reviewable. For installed packages in the 0.4.0 preview, [extension updates and choices have their own review path](extensions.md).
