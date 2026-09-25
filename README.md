# GitDocket

Keep your project’s docs, tasks, and decisions together in Git, so your coding agent can pick up where you left off.

Ask your agent to make a change, check the result, and update the relevant docs. For example, a contributor-guide task can record why documentation links should work offline. The next session can use that decision when adding a troubleshooting guide.

Browse project docs, see what is ready next, and review completed work in the local web interface. Your agent uses editable workflows stored in the same repository. GitDocket runs locally and needs no hosted account.

> GitDocket 0.6.0 is a preview. File formats and commands may still change.

![Current GitDocket Home showing project context and ready work in the synthetic Harbor project](site/assets/current-home.jpg)

## Install

Install with Homebrew:

```sh
brew install gitdocket/tap/gitdocket
docket --version
docket-mcp --version
```

You need Homebrew and Git on macOS 15+ or supported glibc Linux, on ARM64 or x64. See [supported platforms, updates and migration](docs/homebrew.md).

If you already use Node 22 or later, npm is a supported alternative:

```sh
npm install -g --include=optional @gitdocket/cli @gitdocket/mcp
```

Keep optional dependencies enabled. See [npm and npx details](docs/npm.md).

## Quickstart

From the repository you want to track:

```sh
docket init
docket overview
docket serve
```

`docket init` creates a `docket/` folder for project knowledge and work, plus instructions for your agent. Existing files stay in place; you can add your existing docs gradually.

`docket serve` opens a web interface on your own computer. Keep it on loopback: the server has no authentication or TLS. See [local-server safety](docs/serve.md).

To install native guidance for a supported coding agent:

```sh
docket init --agent cursor
docket init --agent codex
docket init --agent claude
```

For Cursor, enable Docket once in Customize → MCPs after initialization. Open a fresh agent session and ask it to create and complete one small task. The [one-task walkthrough](docs/getting-started.md) shows what to ask, how to review the result, and how to use a recorded decision in the next session. Use [epics](docs/epics.md) for larger outcomes.

## What is in a bundle?

A bundle is a folder of linked Markdown: documentation, decisions, tasks, epics, and agent workflows. Tasks store their status and dependencies in frontmatter. A task becomes ready when it is todo and all its dependencies are done.

The [basic example](examples/basic/) is a complete synthetic bundle. See [Getting started](docs/getting-started.md), [Everyday use](docs/everyday-use.md), [Concepts](docs/concepts.md), [CLI reference](docs/cli.md), [local-server safety](docs/serve.md), and [agent integration](docs/agents.md).

## Make your process part of the project

Workflow extensions let your team reuse its steps for planning, building, and reviewing a change. Save templates and checks in your repository, and use tools already connected to your agent. Start with one task and add a workflow when you need it.

In the [Beacon walkthrough](examples/product-delivery/README.md), an agent prepares an export proposal, implements the accepted scope, records verification and leaves a decision that a fresh session uses to plan import. Read the [workflow overview and reference](docs/extensions.md) to adopt or author a package. The walkthrough lists the example app’s setup requirements.

## Stability and upgrades

GitDocket is in preview. After updating the application, run `docket upgrade --dry-run` in each project to review changes to its supplied workflows. Run `docket upgrade` to apply them, then resolve any conflicts with your customizations.

## Telemetry

Telemetry is **local only and off by default**. Collection requires explicitly running `docket telemetry enable` for each checkout. Observations stay on your computer, outside your repository; GitDocket never uploads them. Run `docket telemetry disable` to stop collection or `docket telemetry delete` to remove the current checkout's enrollment and recorded data.

## Contributing and security

This public repository is release-fed from a private canonical development repository. Issues and feedback are welcome; source pull requests are not accepted during the first preview because an inbound synchronization workflow does not yet exist. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue.

Please do not report vulnerabilities in a public issue. Use the repository’s private vulnerability-reporting form described in [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
