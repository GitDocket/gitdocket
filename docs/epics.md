# Grow to an epic

Use an epic when several tasks contribute to one outcome. Start with the [one-task tutorial](getting-started.md) if you are new to GitDocket.

## Try a small epic

Initialize a scratch Git repository with the adapter for your agent:

```sh
docket init --agent cursor
```

Choose `--agent codex` for Codex or `--agent claude` for Claude Code. Omit the flag for portable `AGENTS.md` guidance. For Cursor, enable Docket once in Customize → MCPs.

Open the repository in a fresh agent session and ask:

> Create a “Welcome guide” epic with two dependent tasks: write a short contributor guide, then link it from README. Give each task concrete acceptance criteria. Run that epic through completion, verify the guide and links, and reconcile the docs.

The agent creates the epic and tasks, writes the guide, checks it, and updates the docs. Dependencies keep the work in order: the README task becomes ready once the guide task is done. Before closing the epic, the agent checks the overall result.

## Review the result

```sh
docket task list --all
docket ready
```

On a successful run, the two tasks and their epic are done. Open the README link, read the guide, and review the checks described in each Outcome and the linked Git commits. If the agent reports an issue it cannot resolve, address it and resume the same epic.

In a later session, ask “Where did we leave off?” The agent can use the saved task state, docs, and Git history to answer. A written re-entry note may need refreshing; readiness is calculated from current task files.

To start an existing item yourself, use its actual ID from `docket task list`:

```sh
docket task start <ID> --json
```

See the [Harbor demonstration](../site/demo/README.md) for a repeatable scripted CLI run with its task files and checks.
