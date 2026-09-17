---
type: Playbook
title: Inspect exact-revision delivery checks
description: Bind every observed PR and check result to the source revision it actually covers.
---

Resolve this recipe's declared capability through the current `product-delivery` bindings and the host's actual tool inventory/schema. A binding is a hint, never tool availability or authority. A missing bound tool is unavailable. With no binding, use only a uniquely applicable tool; if multiple plausible tools remain, report ambiguity and request selection. Do not install tools or obtain credentials.

Resolve the declared checks-read capability from current host tools. Request the explicitly selected PR, using effective `prNumber` only for that matching PR, and exact candidate code revision established by retained implementation evidence. Match effective `codeRevision` to that evidence, deriving it from the evidence when the configured value is empty, and retain the actual returned head, each check's revision and status, observation provenance and timestamp. Compare all check revisions with the intended source; a passing result for a different revision is stale evidence and must not justify a verified handoff. Failed checks or a revision mismatch leave readiness unresolved.

If the tool is unavailable, retain the local verification sources and explicitly report the integration gap. Do not invent a PR or remote checks, silently substitute another revision or rerun unrelated procedures. A synthetic protocol fixture is evidence of tool integration behavior only; it does not prove a live host ran the app's tests.
