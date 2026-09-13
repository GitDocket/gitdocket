---
type: Workflow
title: Close a task
description: Close a task — outcome write-up citing commits, doc reconciliation, index/log updates. Definition of done lives here.
origin: docket-close@0.2.1
tags: [docket, workflow]
timestamp: 2026-07-21T19:20:03Z
---

Close the given task (default: the ID in `.docket/active-task`). Closing is the moment the wiki gets paid — don't skip steps.

Stored status changes go through the engine's canonical transition table; invalid transitions are rejected and `done` is terminal.

The engine owns the state-machine-checked move to `done` and optional dated Log mutation; the close workflow owns done-ness review, Outcome and documentation judgment, and derived index/log reconciliation. Prefer `docket task close <ID> --note "…"` for the engine-owned mechanical part.

1. **Verify done-ness**: every acceptance criterion checked (or explicitly waived in the Outcome with a reason). If not done, say so and stop.
2. **Write `# Outcome`**: what actually shipped, citing commit hashes — find them via `git log --grep "Task: <ID>" --oneline` plus the task file's own history. Note anything descoped or discovered.
3. **Reconcile the docs** (the LLM-first step): from the diff of those commits, identify wiki concepts (`specs/`, `reference/`, `decisions/`, plan documents) the change invalidates or extends. Update them now. If a choice foreclosed alternatives during the work, record it as a `type: Decision` concept in `decisions/` and link it from the Outcome.
4. **Update state**: final `# Log` entry; `docket index`; add a `log.md` entry; check whether this unblocks tasks (their `depends_on` now all done) and whether the epic itself is complete — if so, note it in the epic's Log and propose closing it.
5. **Commit everything together** — task file + reconciled docs + index/log — with the `Task: <ID>` trailer (keep the task active so the hook injects it, or add it manually), then `docket task stop` to clear the active task.

The commit that closes a task must contain the doc reconciliation — that's the product's core promise.
