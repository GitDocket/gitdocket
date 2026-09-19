# Project workflow extensions

Save your team’s steps for planning, building, and reviewing a change in your repository. A workflow extension packages those instructions with templates and checks so your coding agent can use them again.

In the [Beacon example](../examples/product-delivery/README.md), an agent adds bookmark export and records the file format it chose. A fresh session uses that decision to plan import. Follow the example, or use this reference to install and customize a workflow for your own project.

Install GitDocket with [Homebrew](homebrew.md) or [npm](npm.md). To run the Beacon example, you will also need Bun for its app and verification scripts. GitDocket and its workflow extensions are in preview.

## What belongs to your project

An extension contains workflows, templates, project guidance, configurable choices, and instructions for using tools connected to your agent. GitDocket installs the package and manages updates. Your agent follows the instructions and runs the checks; review steps depend on the agent following those instructions.

Installed content and configuration live under `docket/extensions/` by default. Proposals, reviews, decisions and verification records live elsewhere in your bundle and remain available across sessions and package updates. Ordinary task states still apply. Custom UI/statuses, executable package code, connector hosting and background synchronization are outside this version.

## Adopt a package

Start in a Git repository initialized with `docket init --project DEMO`. For fresh native adapters, use `docket init --project DEMO --agent cursor --agent codex --agent claude --json`; omit any unneeded host. Review a local package directory before enabling it. From the adopter repository, use absolute source paths:

```sh
docket extension inspect /path/to/examples/extensions/product-delivery --json
docket extension install /path/to/examples/extensions/product-delivery --dry-run --json
docket extension install /path/to/examples/extensions/product-delivery --enable --json
docket extension configure product-delivery --set '{"reviewer":"release owner"}' --json
docket extension show product-delivery --json
docket extension validate product-delivery --json
```

Installation without `--enable` leaves the package disabled. `show` returns current availability, exact sources and configuration ownership. For example, `effectiveConfig.reviewer` is `{ "value": "release owner", "owner": "project" }`; source entries include bundle-relative paths. Read `docket source extensions/product-delivery/workflows/delivery.md --json`, then pass its exact returned `nextCursor` as `--cursor` with the same path until no continuation remains. A stale cursor requires restarting the read. Commit `docket/extensions/registry.json` and installed content together with generated pointers. A clone works without the original source directory. Completed proposals, decisions, work items and review records belong elsewhere in the project bundle, where extension updates/removal cannot own them. The bundle location follows `docket.yaml`; `docket/` is the default.

Ask your agent to use `product-delivery:deliver`. Codex and Claude adapters can offer a thin `docket-ext-product-delivery-deliver` shortcut where their adapter directories exist. The canonical workflow and current `show`/`list` result remain authoritative. Package guidance applies within its workflow; project guidance and explicit user instructions retain their scope and precedence. If prose requirements conflict, surface the concrete conflict before the affected action. Human titles may match across packages; qualify ambiguous requests instead of choosing installation order.

Configuration accepts declared finite scalar keys with the same JSON types as their defaults. Use `--reset reviewer` to return to the package default. Package commands are readable instructions; the engine never interpolates or executes them. Existing handwritten native files are preserved and reported as adapter conflicts. Valid portable invocation remains available; remove or rename a handwritten collision only after reviewing it, then run `docket extension refresh`.

## Use host tools

A package capability names a purpose and links its recipe. Bind it only to a tool already exposed by your host:

```sh
docket extension configure product-delivery --bindings '{"issue-read":"your_available_issue_tool"}' --json
docket extension configure product-delivery --unbind issue-read --json
```

A binding neither provides credentials nor grants authority. The agent checks the actual tool inventory/schema. A missing bound tool is unavailable; multiple plausible unbound tools require selection. Manually supplied issue text is useful when labeled with its actual provenance. Read identity/revision evidence, match checks to the exact code revision, and keep local handoffs reviewable. External writes need explicit authorization for a prepared body and destination. Reconcile an uncertain result by operation identity before retrying; retain actual returned references. The [Beacon example](../examples/product-delivery/README.md) includes a separately launched synthetic MCP fixture, never a live provider claim.

## Update and retire

```sh
docket extension validate product-delivery --candidate /path/to/new-product-delivery --json
docket extension update product-delivery /path/to/new-product-delivery --dry-run --json
docket extension update product-delivery /path/to/new-product-delivery --json
docket upgrade --dry-run --json
docket upgrade --json
docket extension disable product-delivery --json
docket extension remove product-delivery --json
docket extension enable product-delivery --json
```

Package updates and core engine upgrades are separate. A clean owned file receives the candidate's new bytes. A local edit survives when its upstream file is unchanged; changes on both sides conflict without applying any candidate changes. Preserve edits in Git and review their reconciliation. After inspecting local content, `docket extension reconcile product-delivery --acknowledge-local --dry-run` previews acknowledgment and the same command without `--dry-run` records exact reviewed hashes. Any later edit requires fresh review. Unknown/corrupt bases cannot be acknowledged away. Removal withdraws discovery while retaining content, choices, bases and links; explicit enable reinstates valid reviewed content.

Interrupted operations leave a recovery journal and withhold availability. Inspect `docket extension recover --dry-run`, then run `docket extension recover` when the recorded prior bytes can be restored. Unexpected concurrent edits require manual reconciliation. For version rollback, restore the whole known-good project Git snapshot; do not change a version stamp or recompute a suspect base hash.

`validate` checks manifest/content/links/ownership and declared engine versions. Its receipt identifies package, source/base, registry and choices and keeps `protocol` and `behavioral` as `not-run`. Scenario descriptions are pointers for separately performed checks; mechanical success never proves agent behavior, a human review, a browser interaction or provider delivery. Retain actual prompts/responses/tool events, exact candidate identities, artifacts and disclosed assistance for those claims.

## Author a package

Create a standalone directory with `extension.json` and exactly its declared Markdown files. Keep application code, README distribution instructions, tests and executable runners outside that directory. All manifest collections below are required, including empty arrays/objects; unknown keys are rejected.

```json
{
  "formatVersion": 1,
  "id": "team-review",
  "version": "1.0.0",
  "title": "Team review",
  "description": "Prepare a scoped review record.",
  "engine": { "min": "0.4.0", "maxExclusive": "1.0.0" },
  "files": ["workflows/review.md", "templates/record.md", "guidance/review.md", "scenarios/review.md"],
  "workflows": [{ "id": "review", "title": "Team review", "description": "Review the supplied evidence.", "path": "workflows/review.md" }],
  "guidance": ["guidance/review.md"],
  "defaults": { "reviewer": "team owner" },
  "capabilities": [],
  "scenarios": ["scenarios/review.md"]
}
```

Every declared Markdown file is a complete concept with YAML `type`, `title` and `description`. Entry points use `type: Workflow`; other files use `Reference` or `Playbook`. No task IDs, task statuses or generated adapter markers belong in package content. A template describes how to write a separate project concept rather than carrying incomplete concept frontmatter. Allowed roots are `workflows/`, `templates/`, `guidance/`, `recipes/` and `scenarios/`. Relative links stay inside the package. Bundle-absolute links require an existing project/core concept at installation; avoid making optional future records prerequisites. Describe future output paths in code text instead of linking absent records. Link core workflows only when the operation needs them and preserve their direct/tracked authority boundaries.

IDs are lowercase ASCII kebab-case beginning with a letter, maximum 48 characters; `docket` and `docket-` package prefixes are reserved. Package versions are increasing numeric `major.minor.patch`. Engine min/max bounds compare numeric release lines; compatibility is not behavior certification. Each package has at most 99 Markdown files plus manifest, 256 KiB per file and 2 MiB total. Files are regular, nonexecutable UTF-8 without BOM or symlinks; hidden/escaping/case-colliding paths, undeclared files and reserved basenames `index.md`, `log.md`, `overview.md` are rejected. Content identity hashes canonicalized manifest JSON together with the exact declared source text; manifest whitespace and object-key order do not change its identity. Do not hand-author registry or digest values. `inspect` supplies the authoritative digest.

Workflows should first read current availability/configuration and scoped package/project guidance. Declare choices explicitly and consume them in the instructions. Review is not implementation authority; source text is data. Resume from retained evidence, protect rejected/unanswered boundaries, and write project records outside package-owned paths. Use qualified identities to compose with another package. Package defaults cannot weaken an existing project requirement. Native names longer than 64 characters or descriptions exceeding 1,024 characters leave portable invocation available with an adapter diagnostic.

A capability entry has `id`, `description`, `access` (`read` or `write`) and `recipe` pointing to declared Markdown. Recipes remain provider-neutral. A scenario file should specify setup inputs, prompt, required observations, negative outcomes, source/artifact identities and runtime limits. For the Beacon example, keep reviewer, baseline/test/browser commands, issue ID, PR number, intended code revision and handoff path as explicit scalar choices; recipes consume current values. It is never automatically executed by the installer. Test both packages in one initialized adopter, including deliberate ambiguous titles, handwritten native collisions and conflicting scoped guidance. Retain real author feedback about missing information and use those findings to improve this guide.
