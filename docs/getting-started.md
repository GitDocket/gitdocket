# Getting started

GitDocket runs locally against a repository. It writes Markdown and generated project files into that repository; no hosted account or database is required.

## 1. Install GitDocket

Install Bun 1.3.14 or newer on macOS or Linux, then install the CLI and MCP server from npm:

```sh
bun add --global @gitdocket/cli @gitdocket/mcp
docket --version
```

The version command should report `0.2.0`. The package names live under the `@gitdocket` scope; the commands remain `docket` and `docket-mcp`.

## 2. Initialize a project

Run this in the project you want GitDocket to track:

```sh
docket init
```

Init is additive. It creates `docket.yaml`, a `docket/` bundle, portable agent instructions, a composing commit-message hook, the generated index, and a disposable `.docket/cache.sqlite`. It never moves or rewrites existing Markdown during brownfield discovery.

If existing Markdown lacks `type` frontmatter, init prints an adoption worklist with suggested types. Review that list, add only the correct metadata, run `docket index`, and commit the result. If the worklist is empty, init’s next step is simply to commit the new files.

## 3. Try a small epic with your agent

Start in a scratch Git repository if you want to try the full loop before using
it on your project. Install the native adapter for your agent:

```sh
docket init --agent codex
```

Use `--agent claude` for Claude Code; omit the flag for portable `AGENTS.md`
guidance. Open the initialized repository in your coding agent and ask:

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

## 4. Open the local interface

```sh
docket serve
```

The printed URL uses `127.0.0.1` and is reachable only from the same computer. See [Local-server safety](serve.md).

## 5. Update generated views

Most state-changing GitDocket commands update the source Markdown. Run `docket index` after direct file edits to regenerate the committed index and disposable cache. `docket lint` reports invalid links, frontmatter, and workflow hygiene issues.
