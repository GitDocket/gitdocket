# Grow to an epic

Use an epic when several dependent tasks contribute to one outcome. Start with the [one-task tutorial](getting-started.md).

## Try a small epic with your agent

Start in a scratch Git repository if you want to try the full loop before using
it on your project. Install the native adapter for your agent:

```sh
docket init --agent cursor
docket init --agent codex
```

Use `--agent claude` for Claude Code; omit the flag for portable `AGENTS.md` guidance. After `--agent cursor`, enable Docket once in Customize → MCPs. Open the initialized repository in your coding agent and ask:

> Create a “Welcome guide” epic with two dependent tasks: write a short
> contributor guide, then link it from README. Give each task concrete
> acceptance criteria. Run that epic through completion, verify the guide
> and links, and reconcile the docs.

The agent uses the checked-in workflows to create the epic and scoped tasks,
select work whose dependencies are done, perform and verify changes, and update
affected documentation. It reviews the overall epic before closing it and
returns a completion receipt or a concrete blocker. You direct the work and
review the result; this runs in the agent session, with that agent's permissions.

Inspect the result:

```sh
docket task list --all
docket ready
```

On a successful run, both child tasks and their epic are `done`; their Markdown
contains checked criteria, an Outcome, and task-linked Git commits. Confirm the
README link opens the guide and that the completion receipt explains its checks
and documentation changes. If the agent reports a blocker, resolve the named
issue before resuming the same epic.

In a later session, ask “Where did we leave off?” The agent can read repository
state and Git evidence without the previous conversation. A re-entry note is
authored context and may need refreshing; current readiness comes from Docket.

For an existing tracked item, use its real ID returned by `docket task list`:
`docket task start <ID> --json`. Bare selection is reserved for an explicit
request to choose the next backlog item. A new project has no pre-existing
`DEMO-3` task.

The [scripted Harbor demonstration](../site/demo/README.md) includes a repeatable
CLI run and actual evidence. It illustrates the workflow; it is not a recording
of autonomous agent execution.


The historical Harbor replay is scripted CLI evidence, not an agent execution recording.
