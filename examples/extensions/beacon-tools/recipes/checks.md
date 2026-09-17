---
type: Playbook
title: Inspect exact-revision delivery checks
description: Bind every observed PR and check result to the source revision it actually covers.
---

Resolve the declared checks-read capability from current host tools. Request the configured PR and exact codeRevision, and retain the actual returned head, each check's revision and status, observation provenance and timestamp. Compare all check revisions with the intended source; a passing result for a different revision is stale evidence and must not justify a verified handoff. Failed checks or a revision mismatch leave readiness unresolved.

If the tool is unavailable, retain the local verification sources and explicitly report the integration gap. Do not invent a PR or remote checks, silently substitute another revision or rerun unrelated procedures. A synthetic protocol fixture is evidence of tool integration behavior only; it does not prove a live host ran the app's tests.
