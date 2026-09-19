# Complete one useful change

Try GitDocket by asking your coding agent to complete a small task. Review the result, then open a fresh session and see how it uses a decision recorded during that work.

## 1. Install and initialize

You need Homebrew, Git, and a coding agent. See [supported platforms](homebrew.md#supported-platforms) or the [npm alternative](npm.md).

Install with Homebrew and create a small practice project:

```sh
brew install gitdocket/tap/gitdocket
docket --version
docket-mcp --version
mkdir docket-playground
cd docket-playground
git init
printf '# Harbor\n\nA synthetic documentation project.\n' > README.md
docket init --agent codex
git add .
git commit -m "Initialize Harbor with Docket"
```

The example uses Codex. Choose `--agent cursor` for Cursor or `--agent claude` for Claude Code; omit the flag for portable `AGENTS.md` instructions. For Cursor, enable Docket once in Customize → MCPs (Command Palette: Open MCPs).

Open the initialized repository in a fresh agent session so it discovers the project instructions. If Git asks for an author identity, configure your usual name and email before committing.

In an existing project, run `docket init` there instead. It leaves your existing files in place and creates a `docket/` folder for docs and work. You can add existing documentation gradually.

## 2. Ask for one tracked change

Paste this into your coding agent:

> Read this project's context. Create one standalone Docket task to add a short contributor guide at docket/reference/contributing.md and link it from README.md. Use Reference frontmatter on the guide, with First step and Review sections. Since this project should remain useful offline, record the decision to use repository-relative documentation links in docket/reference/documentation.md, and explain how future guides should follow it. Acceptance criteria: both guide sections exist, the README link resolves, and the documentation decision is recorded. Start the created task by its actual ID, complete and verify it, reconcile affected docs, and close it with an Outcome and task-linked Git evidence. Do not create a spec or epic.

The agent creates a task, writes the guide, checks it, and records the result. It also saves the decision about offline links so the next session can find it. If the agent needs something from you, resolve the issue it names and ask it to resume the same task.

## 3. Inspect the result

```sh
docket task list --all
docket ready
git log -5 --format=full
git status --short
docket serve
```

Open the local URL printed by `docket serve`. Find the completed task on the Board, or read its Markdown file under `docket/work/tasks/`. Its Outcome should explain the change and the checks performed.

Open the README link, check the two guide sections, and read the saved documentation decision. Review the Git diff as well. You should have one completed task and no pending work yet.

You can also edit docs in the browser. Save writes local files; review `git diff` and commit when ready. The Home briefing is optional—your tasks, docs, and Git history already provide context.

## 4. Use the knowledge in a fresh session

Open a new agent session in the same repository and ask:

> Where did we leave off? Using repository evidence, explain how we should add a troubleshooting guide and make it discoverable. Cite the project decision that affects your recommendation. This is a read-only planning request; do not create or start work.

Look for a recommendation that cites the saved decision and uses relative links for the troubleshooting guide. You did not repeat that requirement: the agent should find it in the project.

See [one task and a fresh session](../site/demo/single-task/README.md) for an example with the task, recorded decision, and a separate agent’s response.

## Continue in your project

Choose a small documentation fix, missing test, or bug with a clear result. Ask for a task when you want to keep its scope, checks, and outcome; a quick typo fix can stay a direct request. Use the returned task ID to start or resume tracked work.

Read [Everyday use](everyday-use.md) for saved project instructions, browser editing, and keeping docs current. Use [epics](epics.md) when several tasks contribute to one outcome.

After editing source files directly, `docket index` refreshes generated views and `docket lint` checks links and metadata. The [concepts guide](concepts.md), [CLI reference](cli.md), [agent integration](agents.md), and [local-server guide](serve.md) explain the details.
