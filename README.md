# GitDocket

GitDocket helps your coding agent pick up a project with less re-explanation. It keeps project docs, tasks, and working instructions together as linked Markdown in your repository, so you can review what changed, why, and what was checked.

The loop is simple: read project context → choose a change → implement and verify → update the project's knowledge → use that knowledge for the next change. For example, a completed contributor-guide task can record a decision to use repository-relative links; a later agent can use that decision when planning a new guide.

Docket's engine manages IDs, allowed status changes, dependency readiness and generated views. Your coding agent follows editable supplied workflows to verify work and reconcile affected docs. A done status records a conclusion; review the checks and Git diff that support it. No hosted account is needed: the files and history stay yours.

> GitDocket 0.5.0 is a preview. File formats and commands may still change as external use provides evidence.

![Current GitDocket Home showing project context and ready work in the synthetic Harbor project](site/assets/current-home.jpg)

## Install

With Homebrew and Git on macOS or Linux, install both commands:

```sh
brew install gitdocket/tap/gitdocket
docket --version
docket-mcp --version
```

No separate Bun, Node or npm setup is needed. The project-maintained Homebrew formula supports macOS 15+ on Apple Silicon and Intel, and Homebrew-compatible glibc Linux on ARM64 and x64; native qualification uses Ubuntu 24.04. Windows is not supported. The fully qualified command grants trust to this formula. See [platforms, updates and migration](docs/homebrew.md).

If you already use Node 22 or later, npm is a supported alternative:

```sh
npm install -g --include=optional @gitdocket/cli @gitdocket/mcp
```

Both routes install the same standalone release. The npm commands also need no separate Bun installation; keep optional dependencies enabled. See [npm and npx details](docs/npm.md).

## Quickstart

From the repository you want to track:

```sh
docket init
docket overview
docket serve
```

`docket init` adds the bundle, workflow guidance, commit hook, generated index, and local cache without moving existing files. In a brownfield repository it lists Markdown files that still need a reviewed `type` field and leaves them untouched.

`docket serve` opens on `127.0.0.1` only. It is intended for the person using the same computer; it has no authentication or TLS and is not a LAN or hosted team server.

To install native guidance for a supported coding agent:

```sh
docket init --agent cursor
docket init --agent codex
docket init --agent claude
```

Once initialized, ask your agent to create and complete one small contributor-guide task. Review its criteria, Outcome, checks, affected docs and task-linked Git changes. The [one-task walkthrough](docs/getting-started.md) provides exact commands and a fresh-session prompt that uses a recorded project decision. No spec or epic is required; [epics](docs/epics.md) are a follow-on for larger outcomes.

## What is in a bundle?

A Docket bundle is one link graph containing documentation, decisions, tasks, epics, and agent workflows. Work state is ordinary frontmatter. Ready work is derived from `status: todo` plus completed dependencies; it is never another stored state.

The [basic example](examples/basic/) is a complete synthetic bundle. See [Getting started](docs/getting-started.md), [Everyday use](docs/everyday-use.md), [Concepts](docs/concepts.md), [CLI reference](docs/cli.md), [local-server safety](docs/serve.md), and [agent integration](docs/agents.md).

## Make your process part of the project

Workflow extensions let your team share a repeatable path from request to reviewed delivery. Adapt the reviews, templates and checks, use tools already connected to your agent, and keep the decisions available for the next change—all in Git. They are optional; one task is still a useful place to start.

In the [Beacon walkthrough](examples/product-delivery/README.md), an agent prepares an export proposal, implements the accepted scope, records verification and leaves a decision that a fresh session uses to plan import. Read the [workflow overview and reference](docs/extensions.md) to adopt or author a package. Workflow extensions are included in the 0.5.0 preview. The example app has its own development prerequisites.

## Stability and upgrades

The first public release is a preview: file formats and commands are tested, but compatibility guarantees are intentionally narrow until real external use provides evidence. Vendored workflow files carry their originating GitDocket version; `docket upgrade` performs a three-way merge so local edits remain explicit.

## Telemetry

Telemetry is **local only and off by default**. Collection requires explicitly running `docket telemetry enable` for each checkout. Observations stay on your computer, outside your repository; GitDocket never uploads them. Run `docket telemetry disable` to stop collection or `docket telemetry delete` to remove the current checkout's enrollment and recorded data.

## Contributing and security

This public repository is release-fed from a private canonical development repository. Issues and feedback are welcome; source pull requests are not accepted during the first preview because an inbound synchronization workflow does not yet exist. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue.

Please do not report vulnerabilities in a public issue. Use the repository’s private vulnerability-reporting form described in [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
