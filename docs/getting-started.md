# Complete one useful change

GitDocket helps your coding agent resume with less re-explanation. Try one small tracked change, review its checks, and see how the knowledge helps the next session. No spec, epic, populated wiki, Home briefing or project guidance is required.

## 1. Install and initialize

GitDocket 0.4.0 installs both commands with Homebrew. You need Homebrew and Git on macOS 15+ or supported glibc Linux, on ARM64 or x64. Windows is not supported. No separate Bun, Node or npm setup is needed:

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

The fully qualified install command grants trust to the project’s formula. If you already have Node 22+, use `npm install -g --include=optional @gitdocket/cli @gitdocket/mcp` instead. See [installation, updates and migration](homebrew.md) or the [npm guide](npm.md).

Use `--agent claude` for Claude Code, or omit the agent flag for portable `AGENTS.md` guidance. Open the initialized repository in a new coding-agent session so it discovers those instructions. If Git cannot commit, configure your usual Git author identity and retry. Init adds a local Markdown bundle, configuration, workflow instructions, index and commit hook. It leaves existing files in place. In an existing project, review its adoption worklist before adding metadata to existing docs; a complete document migration is not a prerequisite for one task.

## 2. Ask for one tracked change

Paste this into your coding agent:

> Read this project's context. Create one standalone Docket task to add a short contributor guide at docket/reference/contributing.md and link it from README.md. Use Reference frontmatter on the guide, with First step and Review sections. Since this project should remain useful offline, record the decision to use repository-relative documentation links in docket/reference/documentation.md, and explain how future guides should follow it. Acceptance criteria: both guide sections exist, the README link resolves, and the documentation decision is recorded. Start the created task by its actual ID, complete and verify it, reconcile affected docs, and close it with an Outcome and task-linked Git evidence. Do not create a spec or epic.

The agent reads context, creates a task with verifiable criteria, implements the change and checks it. The close workflow asks the agent to update affected docs and record evidence. Docket manages IDs, state changes and readiness; your agent performs the work with its own tools and permissions. If it reports a concrete blocker, resolve the named issue and ask it to resume that same task ID.

## 3. Inspect the result

```sh
docket task list --all
docket ready
git log -5 --format=full
git status --short
docket serve
```

Open the printed local URL. Inspect the completed task on the Board, or read its file under `docket/work/tasks/`. Expect exactly one done task with checked criteria and an Outcome explaining what shipped and what was checked. Open the README link, verify both guide sections, read the documentation decision, and review the task-linked Git diff. The task and checks explain the result; the reference doc leaves useful knowledge for later work. A clean fixture has no next ready task. Docket does not invent one.

An empty Home briefing is valid. Task files, docs and Git history still provide context; the agent does not need to fabricate a summary. Default browser edits save local, uncommitted files. Review Git status before committing. GitDocket includes the shared document editor and optional project guidance; neither is required for this tutorial.

## 4. Use the knowledge in a fresh session

Close the agent session, open a new one in the same repository, and ask:

> Where did we leave off? Using repository evidence, explain how we should add a troubleshooting guide and make it discoverable. Cite the project decision that affects your recommendation. This is a read-only planning request; do not create or start work.

Check that the answer finds the previous Outcome and recorded decision, proposes links consistent with it, and cites the file. The prompt deliberately does not repeat the decision. Recovering a done status alone is not the goal: earlier knowledge should shape the new recommendation. Authored briefings require an explicit refresh when they age; current readiness is derived from task files.

See [one task and a fresh session](../site/demo/single-task/README.md) for the retained scripted run and separate agent response.

## Continue at your own pace

For an existing project, choose a small documentation fix, missing test or bounded bug with an observable result. Ask for a task when its criteria and durable receipt will help; a direct “fix this typo” request need not create tracked work. Use the real returned task ID when starting or resuming it. For a larger outcome, follow [Grow to an epic](epics.md). Optional saved standards and browser editing are explained in [Everyday use](everyday-use.md) once you are using a build that includes them; they are not required for this tutorial.

`docket index` regenerates views after direct source edits. `docket lint` checks explicit links, metadata and workflow hygiene. The [concepts guide](concepts.md), [CLI reference](cli.md), [agent integration](agents.md), and [local-server safety](serve.md) provide details as you need them.
