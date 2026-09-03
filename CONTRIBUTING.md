# Contributing

GitDocket’s public repository is release-fed from a separate canonical development repository. During the first public preview, use GitHub issues for bug reports, reproducible compatibility findings, documentation gaps, and focused feature proposals.

Source pull requests are not accepted yet: there is no supported inbound synchronization path, and merging a public-only change would create two competing sources of truth. This is a workflow constraint, not a claim on the value of outside contributions. The policy can change after an explicit synchronization and governance process exists.

Before opening an issue:

1. Search existing issues.
2. Reproduce with the newest preview on a supported Bun version and platform.
3. Include the smallest project or synthetic bundle that demonstrates the behavior.
4. State the expected and actual result without including private repository content.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) and use private vulnerability reporting instead of an issue.

Project decisions are made by the maintainers and recorded in release notes or public documentation. The public preview has no formal voting body, contributor ladder, or guaranteed response time.
