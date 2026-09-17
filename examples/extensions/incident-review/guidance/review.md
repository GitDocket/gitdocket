---
type: Reference
title: Incident review package guidance
description: Scoped reviewer choice, evidence standards and project ownership for incident reviews.
---

Apply this guidance only within `incident-review:review`. Installation and discovery do not authorize a review, follow-up work or incident remediation. Current project requirements and explicit user instructions retain their applicable precedence; defaults cannot weaken them. Expose material conflicts before the affected action.

The default `reviewer` is `incident facilitator`, distinct from Product delivery's default reviewer. Consume the current effective value from `docket extension show incident-review --json` and state its ownership. This identity identifies the review target; it provides neither acceptance nor contact permission. Project overrides of this package never alter another package's choices.

The output is an evidence-based local review, normally under the configured bundle's `reviews/` directory, outside installed package-owned paths. Give it complete `type: Reference`, `title` and `description` frontmatter. Keep source identities, actual provenance, time zones and confidence visible. Separate observations from hypotheses; name missing evidence and unresolved disagreements. Avoid copying secrets or unrelated personal information into the review when a scoped redacted reference can support the finding.

Recommendations remain suggestions until explicit user authority requests concrete follow-up work. No automatic tasks, pickup, application edits, remediation, external messaging or publication follow from a review. Retain useful partial findings when evidence is incomplete and label synthetic exercises as supplied test data. Package updates/removal must not own the review record.
