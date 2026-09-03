# Concepts and files

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

Canonical work states are `todo`, `in-progress`, `blocked`, `in-review`, `done`, and `closed`. `done` means the acceptance criteria were completed. `closed` is a terminal non-completion disposition and does not satisfy dependencies.

Readiness is derived: a task is ready only when it is `todo` and every declared dependency is `done`.

## Decisions and workflows

Decisions are numbered separately and record why an alternative was selected. Workflows are agent-neutral procedures stored in the bundle, versioned like other concepts, and surfaced through generated harness adapters.

## Derived files

`index.md` is committed for review and navigation but regenerated below its marker. `.docket/cache.sqlite` and `.docket/active-task` are local, gitignored checkout state. Deleting the cache loses no source data.
