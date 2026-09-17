---
type: Reference
title: Product delivery release handoff template
description: Reviewable local release evidence and user-facing change description.
tags: [product-delivery, template]
---

Prepare a separate project-owned local handoff outside installed package directories only from completed verification. This template is not release evidence or authorization to post or publish.

Give the output its own complete YAML `type: Reference`, `title` and `description`; retain this template as a reference and replace prompts with actual evidence. Add links only to existing sources.

# User-facing change

Describe the resulting behavior, supported scope and limitations in language appropriate for the product’s users.

# Review evidence

Link the accepted proposal revision and actual review input, implementation tasks and commits, recorded decisions, user documentation and passing verification for the actual candidate. Record PR identity/revision/check observations only if read; otherwise identify local evidence and the integration gap.

# Handoff state

State whether the candidate is ready for release review or remains unresolved and why. Identify the next reviewer action. Retain separately authorized external posting results or uncertainties when they actually occur; local preparation is not publication.
