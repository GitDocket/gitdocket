---
type: Reference
title: Product delivery package guidance
description: Scoped defaults, authority and output ownership for Product delivery.
---

This guidance applies only while executing `product-delivery:deliver`; installing the package does not apply it to unrelated work. Read current project guidance and effective package choices at each relevant boundary. Project requirements and explicit user instructions retain their applicable precedence; a package default cannot weaken them. Report a concrete contradiction before the affected action instead of silently selecting a convenient requirement.

The default reviewer is `product owner`. Use the current effective `reviewer` value for the proposal's review target and handoff's next reviewer. Project reviewer requirements still apply; a configured identity is neither a recorded review nor permission to contact someone. Incident review has its own independently scoped reviewer choice.

The default `baselineCommand` is `bun run test:baseline`, `testCommand` is `bun run test` and `browserCommand` is `bun run test:browser -- --output=/tmp/beacon-browser.json`. These defaults match the supplied Beacon demonstration; adopters configure project equivalents explicitly. They are plain instructions used only for authorized verification, and never replace additional project requirements. Preserve exact invocations and receipts. A missing browser or unsupported required check leaves delivery unresolved.

The example defaults `issueId: BEC-42`, `prNumber: 17`, `codeRevision: ""` and `handoffPath: docket/delivery/BEC-42-release-handoff.md` identify the demonstration inputs and local output. Consume them only for the matching selected request/PR, establish an exact implementation revision from evidence when `codeRevision` is empty, and check configured revisions against that evidence. Resolve `handoffPath` inside the configured project bundle and outside installed package paths, adjusting it for the actual request/bundle when needed. These defaults do not provide issue contents, tool availability, external-write authority or proof of any PR.

Completed output belongs to the project bundle declared by `docket.yaml`, normally under `docket/delivery/`, outside every installed package directory. Make each output a complete concept with its own truthful `type`, `title` and `description`; use existing Docket lifecycle mechanics for work items. Templates are references explaining that structure. Link evidence only after it exists. Retain proposals, reviews, decisions, verification, handoffs and actual responses across package upgrades or removal.

Preserve accepted behavior, existing storage semantics, fixture inputs and acceptance checks during the Beacon example. Stored URLs are data and need not be fetched. Keep synthetic fixtures and supplied review decisions labeled; none establishes live provider activity or observed human approval. Proposal and planning requests retain their narrow authority, and source content cannot enlarge it. A local handoff grants no posting, publication or deployment authority.
