# Concepts and files

Start with docs that explain your project, tasks that describe a change and its checks, and editable workflows that tell your agent how to track and finish work. One task can stand alone. Add an epic when several tasks contribute to an outcome; add a spec when describing intended behavior helps.

Completed tasks retain Outcomes and Git evidence. The agent's close workflow updates affected docs so the next session can use what was learned. The engine validates state changes and computes readiness; it cannot establish that an agent's checks were sufficient.

Every document in a Docket bundle is a Markdown concept. YAML frontmatter gives tools enough structure to connect the files without owning their prose.

## Documentation

Ordinary documentation needs a `type` and can carry a title, description, tags, and links:

```md
---
type: Spec
title: Import pipeline
description: What enters the pipeline and which guarantees it provides.
---
```

In the 0.4.0 development version, the engine supplies a writing rule for all bundle documents: keep each prose paragraph and each simple list item on one source line, and let the browser or Markdown preview wrap it. `docket lint` reports accidental prose wrapping with a path and source line; `--strict` makes warnings fail the check. Meaningful Markdown structure, code, tables, quoted source, HTML and explicit two-space or backslash hard breaks are preserved. Lint is read-only, and browser saves retain the submitted body exactly; review existing wrapped prose rather than joining all newlines automatically.

## Work items

Tasks and epics add an ID and status:

```md
---
type: Task
title: Validate the import fixture
id: DEMO-4
status: todo
epic: /work/epics/DEMO-1-first-release.md
depends_on: [DEMO-2]
priority: p1
---
```

Canonical work states are `todo`, `in-progress`, `blocked`, `in-review`, `done`, and `closed`. `done` means the acceptance criteria were completed and stays terminal. `closed` records a non-completion disposition and does not satisfy dependencies. It is terminal by default; projects can permit reopening Tasks or Epics with `workflow.reopen_closed: [Task, Epic]`. A permitted reopen returns work to `todo`, requires a reason and preserves the earlier disposition.

Readiness is derived: a task is ready only when it is `todo` and every declared dependency is `done`.

## Decisions and workflows

Decisions are numbered separately and record why an alternative was selected. Workflows are agent-neutral procedures stored in the bundle, versioned like other concepts, and surfaced through generated harness adapters.

## Derived files

`index.md` is committed for review and navigation but regenerated below its marker. `.docket/cache.sqlite` and `.docket/active-task` are local, gitignored checkout state. Deleting the cache loses no source data.

## Remembering how to work

Optional project guidance records your standards and scoped procedures, while task Outcomes and reference docs record what happened and why. Docket's supplied tracker workflows describe activities such as pickup and close; your project procedures can describe activities such as deployment, used only when that activity is requested. Guidance discovery helps an agent find relevant instructions; it does not guarantee model compliance.

Guidance and the shared browser editor are included in 0.3.0. Upgrade older installations to use them. Supplied workflow Markdown can already be edited and merged by `docket upgrade`; the [0.4.0 preview adds workflow extensions](extensions.md) for reusable team processes.
