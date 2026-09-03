# Security policy

## Supported versions

GitDocket is preparing its first public preview. Until a stable series exists, only the newest published preview receives security fixes. Older source snapshots and unpublished development commits are unsupported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub’s **Report a vulnerability** action on this repository’s Security page to open a private report with the maintainers.

Include the affected version or commit, operating system and Bun version, reproduction steps, impact, and any suggested mitigation. Please avoid accessing other people’s data or running destructive tests.

The maintainers will acknowledge a report as soon as practical, validate its scope, and coordinate a fix and disclosure timeline. No response-time guarantee or bug-bounty program is offered during the public preview.

## Local-server boundary

`docket serve` is supported only on the same computer and binds to `127.0.0.1`. It is not an authenticated network service. Reports that depend on deliberately exposing it through a tunnel, proxy, LAN bind, or hosted ingress are outside the supported deployment model, though clear hardening observations are still welcome.
