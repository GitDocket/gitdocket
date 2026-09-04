# Getting started

GitDocket runs locally against a repository. It writes Markdown and generated project files into that repository; no hosted account or database is required.

## 1. Install GitDocket

Install Bun 1.3.14 or newer on macOS or Linux, then install the CLI and MCP server from npm:

```sh
bun add --global @gitdocket/cli @gitdocket/mcp
docket --version
```

The version command should report `0.1.1`. The package names live under the `@gitdocket` scope; the commands remain `docket` and `docket-mcp`.

## 2. Initialize a project

Run this in the project you want GitDocket to track:

```sh
docket init
```

Init is additive. It creates `docket.yaml`, a `docket/` bundle, portable agent instructions, a composing commit-message hook, the generated index, and a disposable `.docket/cache.sqlite`. It never moves or rewrites existing Markdown during brownfield discovery.

If existing Markdown lacks `type` frontmatter, init prints an adoption worklist with suggested types. Review that list, add only the correct metadata, run `docket index`, and commit the result. If the worklist is empty, init’s next step is simply to commit the new files.

## 3. Orient and work

```sh
docket overview
docket ready
docket search "release gate"
docket task start DEMO-3 --json
```

Use an explicit task ID to pick up known tracked work. Bare task selection is reserved for an explicit request to choose the next backlog item.

## 4. Open the local interface

```sh
docket serve
```

The printed URL uses `127.0.0.1` and is reachable only from the same computer. See [Local-server safety](serve.md).

## 5. Update generated views

Most state-changing GitDocket commands update the source Markdown. Run `docket index` after direct file edits to regenerate the committed index and disposable cache. `docket lint` reports invalid links, frontmatter, and workflow hygiene issues.
