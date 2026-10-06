# Complete one useful change

GitDocket 0.6.4 is a public preview: expect rough edges and review agent changes. Public preview describes product maturity; the published packages use the latest channel and the GitHub release is not marked as a prerelease. See the [0.6.4 release notes](https://github.com/GitDocket/gitdocket/releases/tag/v0.6.4).

Try GitDocket by asking your coding agent to complete a small task. Review the result, then open a fresh session and see how it uses a decision recorded during that work.

## 1. Install and initialize

You need Homebrew, Git, and a coding agent. See [supported platforms](homebrew.md#supported-platforms) or the [npm alternative](npm.md).

Install GitDocket and verify both commands:

```sh
brew install gitdocket/tap/gitdocket &&
  docket --version &&
  docket-mcp --version
```

Create a practice repository in a new directory. If docket-playground already exists, use an unused name in both the mkdir and cd commands. Keep using the same terminal:

```sh
mkdir docket-playground &&
  cd docket-playground &&
  git init
```

Add a README and initialize GitDocket. This example uses Codex; replace --agent codex with --agent cursor or --agent claude for your agent, or omit it for portable AGENTS.md instructions:

```sh
printf '# Harbor\n\nA synthetic documentation project.\n' > README.md &&
  docket init --agent codex
```

Save the starting point in Git. If Git asks for an author identity, configure your usual name and email, then retry the commit:

```sh
git add . &&
  git commit -m "Initialize Harbor with Docket"
```

For Cursor, enable Docket once in Customize → MCPs (Command Palette: Open MCPs).

Open the initialized repository in a fresh agent session so it discovers the project instructions.

If installation or agent setup stalls, check the [installation and command-path guidance](homebrew.md#moving-from-npm-or-bun), or [ask for help](#help-and-feedback).

In an existing project, run `docket init` there instead. It leaves your existing files in place and creates a `docket/` folder for docs and work. You can add existing documentation gradually.

## 2. Ask for one tracked change

Paste this into your coding agent:

> Read this project's context. Create one standalone Docket task to add a short contributor guide at docket/reference/contributing.md and link it from README.md. Use Reference frontmatter on the guide, with First step and Review sections. Since this project should remain useful offline, record the decision to use repository-relative documentation links in docket/reference/documentation.md, and explain how future guides should follow it. Acceptance criteria: both guide sections exist, the README link resolves, and the documentation decision is recorded. Start the created task by its actual ID, complete and verify it, reconcile affected docs, and close it with an Outcome and task-linked Git evidence. Do not create a spec or epic.

The agent creates a task, writes the guide, checks it, and records the result. It also saves the decision about offline links so the next session can find it. If the agent needs something from you, resolve the issue it names and ask it to resume the same task. If you cannot resolve it, [ask for help](#help-and-feedback) and describe where you got stuck.

## 3. Inspect the result

```sh
docket task list --all &&
  docket ready &&
  git --no-pager log -5 --format=full &&
  git status --short
```

Start the local browser interface. Leave this terminal running; press Ctrl+C when you are finished:

```sh
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

## Help and feedback

Stuck during setup, or unsure what to do next? [Open a GitHub issue](https://github.com/GitDocket/gitdocket/issues/new/choose) or [email me at hello@gitdocket.com](mailto:hello@gitdocket.com) and tell me what you tried. GitHub sign-in is required. Rough impressions and quick notes are welcome; you do not need a diagnosis or a reproducible example to share feedback.

For a bug, include whatever details you have: the GitDocket version (`docket --version`, if it runs), operating system, coding agent, what you expected, what happened, and steps to reproduce it. A small synthetic example helps. Missing details should not stop you from reporting a problem.

Keep private project content, credentials and personal details out of public issues. Compare your installed version with the [release notes](https://github.com/GitDocket/gitdocket/releases) to see what changed.
