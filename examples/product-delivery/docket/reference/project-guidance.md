---
type: Reference
title: Beacon project guidance
description: Project-owned choices and discovery for the portable Product delivery rehearsal.
tags: [guidance, beacon, product-delivery]
---

# General standards

Keep the app dependency-free and entirely local. Use the public-safe fixture data; loading or exporting stored URLs does not require fetching them. Read [delivery records](/delivery/README.md) before planning a related feature, then follow the retained proposal, decisions and verification sources relevant to that request. Apply actual accepted decisions to related planning; do not treat a fixture specification as an accepted product decision.

# Product delivery requests

When the user invokes **Product delivery**, read and execute [Product delivery](/workflows/product-delivery.md). That single Markdown source owns the process and links the required templates. Read this page again on the next invocation so project edits affect the next relevant step. Plain planning requests authorize a sourced plan only; they do not authorize application changes, task creation or task pickup.

Project choices are authored here: the required reviewer is the **product owner**; the preferred issue source is **explicitly supplied issue text**, identified by issue ID and recorded as synthetic when appropriate. The test commands are `bun run test` and `bun run test:browser -- --output=/tmp/beacon-browser.json`; both must pass for release preparation. Use `bun run test:baseline` to confirm storage behavior. A missing Chromium executable means the required browser check is unsupported and delivery is unresolved until it is actually run.

The default handoff is a local reviewable Markdown document. This project has no release publication procedure or authorized external destination. Read access, issue text and supplied test reviews do not themselves authorize posting, installing tools, credentials access or publication. If the user separately requests an external handoff, use an available appropriate capability, retain its result and report unavailable or uncertain integration accurately.
