---
type: Reference
title: Product delivery verification template
description: Exact source and executable application evidence, including failures and unsupported checks.
tags: [product-delivery, template]
---

Fill a separate project-owned record outside installed package directories from actual command output. This template does not assert passing tests.

Give the output its own complete YAML `type: Reference`, `title` and `description`; retain this template as a reference and replace prompts with actual evidence. Add links only to existing sources.

# Candidate identity

Record Git revision, dirty state/diff identity, relevant app hashes, agent host, test/checker source and browser version. Link the accepted proposal and implementation work.

# Checks performed

For each required command record the exact invocation, exit code, output artifact and pass/fail/unsupported result. For the browser check link its JSON receipt, actual downloaded content, request observations, duration and limitations. Explain which assertion proves each acceptance criterion.

# Outcome and next action

State verified behavior and unresolved failures or missing checks. A failed assertion, unsupported browser or source mismatch prevents a ready-for-release-review claim. Record repairs and reruns with their own source identity instead of replacing earlier evidence.
