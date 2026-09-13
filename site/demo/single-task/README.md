# One task, then a fresh session

This synthetic Harbor example uses the public one-task tutorial. The implementation and browser actions are scripted executions of real CLI and Chromium operations. The fresh-reader response is a separate agent run without the implementation conversation. It is controlled agent evidence, not customer research or a guarantee of autonomous success.

## What actually happened

The source candidate at 170b549 (runtime/browser changes through ad033d7), Bun 1.3.14 and macOS initialized a clean Git project with no spec, epic, populated wiki, Home briefing or project guidance. A script created and completed HBR-1: add a contributor guide and README link, then record the decision that documentation should remain usable offline through relative links. It verified both headings and every relative Markdown target in the three changed documents.

Implementation `89d376bd7df94ba493cbc4b97452bde5b1d8a9a1` and closure `7deaaf2f751ffd60e5f67d750671f85f13812d0f` are actual commits in the retained replay. The task has checked criteria and an Outcome; no task remains ready. The command receipt identifies the executed source and operations. Each new replay gets its own timestamps and hashes.

After completion, scripted Chromium actions added an optional writing convention in Project guidance, inspected it, and used Edit guidance → Preview → Save to revise it to require numbered contributor steps with concise imperative wording. The shared editor reported “Saved locally. Changes are not committed.” Git status confirmed the uncommitted source; a separate review commit `d1f601f` then saved the guidance before cloning the repository for the fresh reader. This direct guidance edit created no second task and did not amend the completed task's criteria or evidence.

## Inspect the evidence

- [CLI receipt](receipt.json): actual commands, results and task-linked commits.
- [Completed task source](task.md), [contributor guide](contributing.md), [documentation decision](documentation.md), and [saved instruction](project-guidance.md): exact source snapshots. Their original links resolve inside the replayed repository, rather than this static evidence directory.
- [Browser receipt](browser.json): exact before/after guidance source and performed steps.
- [Editing screenshot](../../assets/guidance-edit.png), [local-save screenshot](../../assets/guidance-saved.png), and [completed-task screenshot](../../assets/single-task-done.png): real candidate UI with synthetic content.
- [Fresh-session prompt and response](handoff.md): actual independent context recovery and application of the saved knowledge.

The basic tutorial succeeds before guidance exists. Guidance and shared browser editing were development-candidate features when this evidence was recorded and are included in 0.3.0, with the supported limits explained in the everyday-use guide. Saving a file does not instantly change an already-running agent's context; the fresh session must discover and read it. This example reuses the separately qualified guidance/editor contracts and adds one combined public-safe check.

## Replay

From a GitDocket source checkout with Bun 1.3.14 or newer and Git:

```sh
bun install --frozen-lockfile
bun scripts/demo-task.ts --output /tmp/harbor-one-task --source YOUR_COMMIT
```

Use a new output directory and replace YOUR_COMMIT with your actual source revision. The script invokes the source CLI and creates the task, reconciled docs, checks, Git commits and receipt. It does not run a model or simulate a response. To reproduce the optional browser step, start the source CLI's Serve command in that fixture, add a scoped instruction in Project guidance, edit it, Preview and Save; inspect Git status, then commit if you want a clean clone. In a separate fresh agent context, use the retained handoff prompt without restating the decision or instruction.

Assistance was fixture location, generated AGENTS discovery and a candidate CLI path, plus evidence-recording instructions. Native installed Codex/Claude execution is not qualified by this run; the guidance feature's client/authentication limits still apply. No private project content, remote service or publication is involved.
