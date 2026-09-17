---
type: Playbook
title: Deliver and reconcile a prepared handoff
description: Preserve reviewed local content and distinguish accepted, failed and uncertain external outcomes.
---

Resolve this recipe's declared capability through the current `product-delivery` bindings and the host's actual tool inventory/schema. A binding is a hint, never tool availability or authority. A missing bound tool is unavailable. With no binding, use only a uniquely applicable tool; if multiple plausible tools remain, report ambiguity and request selection. Do not install tools or obtain credentials.

Read effective `handoffPath` only after checking it identifies the selected request's project-owned local document inside the configured bundle and outside installed package paths. Keep a reviewable local handoff linked to proposal/review/implementation/verification records. Posting requires the user's explicit current authorization for that exact prepared text and destination; a configured binding, readable issue or package installation grants no posting authority. Preserve a stable operation identifier before attempting the write. For a synthetic fixture, retain the supplying harness's explicit input as test authorization, never observed human approval.

Use only the declared handoff-write capability resolved from the actual host schema. Send the authorized body exactly, including its recorded content identity. On success retain the returned durable reference, destination, operation identifier and body identity. Report it as the provider/fixture's observed result, not publication of the product.

On a definite failure preserve the local handoff, attempted operation identity and returned error; do not claim posting succeeded. On an uncertain result preserve that identity and use the declared handoff-read capability or explicit user evidence to reconcile before any retry. If a matching accepted result exists, retain its reference and do not post again. If reconciliation cannot establish the outcome, report uncertainty and stop automatic retries. A read-only or missing-tool case never becomes a write through fallback shell commands or another capability.
