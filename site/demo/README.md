# Historical Harbor epic demonstration

Start with the [one-task example](single-task/README.md). This older epic replay remains a follow-on example.

This small synthetic project was executed with real GitDocket commands. A
script supplied the work and verification steps; this is not a captured agent
conversation or a claim that an unattended agent will always complete an epic.

The authored request was: “Run HBR-1, the Harbor welcome-guide epic, through
completion.” HBR-2 wrote a guide; HBR-3 depended on it and added discovery links
while updating onboarding documentation. After whole-epic review, HBR-1 closed
and HBR-4 became ready for contributor feedback.

## Evidence

- [Command receipt](receipt.json): actual CLI outputs, readiness snapshots,
  assertions, task-linked commits and final state. No private project data.
- [Completed epic screenshot](../assets/epic-complete.jpg): real Serve UI at
  1440 × 1200; only JPEG compression was applied.
- [Welcome guide](welcome.md) and [updated onboarding](onboarding.md): copies
  of the resulting Markdown. Bundle-absolute links in these copies resolve
  inside the replayed project, rather than this static asset directory.
- [Fresh-reader handoff](handoff.md): independent inspection of a clean clone
  without the prior run's conversational context.

## Replay from source

With Bun 1.3.14 or newer and Git, from a GitDocket source checkout:

```sh
bun install --frozen-lockfile
bun scripts/demo-epic.ts --output /tmp/harbor-demo
cd /tmp/harbor-demo
docket ready --json
docket serve
```

The output directory must not already exist; the script never resets an
existing project. It invokes the source CLI with Bun, creates local synthetic
Git commits, and saves `receipt.json`. Install `docket` before using the last
two inspection commands, or invoke the checkout's CLI source with Bun.
Each replay gets new Git timestamps and hashes; compare task order, checks,
content, and final state rather than expecting byte-identical commits.

The captured run used GitDocket 0.1.1 development source at `9a81cde` with Bun
1.3.14 on macOS. The script supports `--cli <cli-source>` and
`--source <revision>` to identify a pinned runtime. It does not publish, run
remote services, or contact an agent provider.

## If a run cannot proceed

The epic workflow requires a concrete blocker receipt identifying what needs
to change. This successful example did not encounter a blocker; that stopping
case is an explanation of the workflow, not fabricated observed output.
